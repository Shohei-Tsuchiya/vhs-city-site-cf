/**
 * VHS City status Worker（Cloudflare Workers 無料枠向け）
 *
 * - Cron / POST /refresh で YouTube 状況を取得し KV に保存
 * - GET /status.json で配信状況を返す
 *
 * 無料枠の制約:
 * - CPU 10ms/回（待ち時間の fetch は除外）
 * - サブリクエスト 50/回 → RSS は少数ローテ、playlist 一括は使わない
 * - KV 書き込み 1,000/日 → 5分おきでも約288回で収まる
 */

import membersConfig from '../data/members.json';

const RSS_CHANNELS_PER_RUN = 18;
const RSS_ENTRIES_PER_CHANNEL = 10;
const VIDEOS_LIST_CHUNK = 50;
const UPCOMING_GRACE_MS = 30 * 60 * 1000;
const UPCOMING_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const LIVE_DISPLAY_TTL_MS = 20 * 60 * 1000;
const LIVE_CARRY_OVER_MS = 3 * 60 * 60 * 1000;
const LIVE_MAX_DURATION_MS = 10 * 60 * 60 * 1000;
const LIVE_ACTUAL_START_GRACE_MS = 20 * 60 * 1000;
const LIVE_START_GRACE_MS = 10 * 60 * 1000;
const LIVE_STARTUP_GRACE_MS = 45 * 60 * 1000;
const STATUS_KV_KEY = 'status.json';

const RSS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; VHSCityStatusBot/1.0; +https://github.com/Shohei-Tsuchiya/vhs-city-site-cf)',
  Accept: 'application/atom+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
};

function flattenMembers(groups) {
  return groups.flatMap((group) =>
    group.members.map((member) => ({
      ...member,
      groupId: group.id,
      groupName: group.name,
      groupColor: group.color,
    }))
  );
}

function selectChannelsForRun(channelIds) {
  const perRun = Math.min(RSS_CHANNELS_PER_RUN, channelIds.length);
  if (perRun >= channelIds.length) return [...channelIds];
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const offset = (bucket * perRun) % channelIds.length;
  const selected = [];
  for (let i = 0; i < perRun; i += 1) {
    selected.push(channelIds[(offset + i) % channelIds.length]);
  }
  return selected;
}

function parseRssVideoIds(xml, limit) {
  const ids = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(xml)) && ids.length < limit) {
    ids.push(m[1]);
  }
  return ids;
}

async function fetchRssVideoIds(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, {
    headers: RSS_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  const xml = await res.text();
  return parseRssVideoIds(xml, RSS_ENTRIES_PER_CHANNEL);
}

async function apiGet(apiKey, endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('key', apiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.json();
  if (!res.ok) {
    const message = body?.error?.message || res.statusText;
    const err = new Error(`YouTube API error (${endpoint}): ${message}`);
    if (/quota/i.test(message)) err.isQuotaExceeded = true;
    throw err;
  }
  return body;
}

async function fetchVideosByIds(apiKey, videoIds) {
  const uniqueIds = [...new Set(videoIds)];
  const videos = [];
  for (let i = 0; i < uniqueIds.length; i += VIDEOS_LIST_CHUNK) {
    const chunk = uniqueIds.slice(i, i + VIDEOS_LIST_CHUNK);
    const data = await apiGet(apiKey, 'videos', {
      part: 'snippet,liveStreamingDetails,status',
      id: chunk.join(','),
    });
    videos.push(...(data.items || []));
  }
  return videos;
}

function isValidLive(video) {
  if (video.snippet?.liveBroadcastContent !== 'live') return false;
  const details = video.liveStreamingDetails;
  if (!details || details.actualEndTime) return false;
  const now = Date.now();
  if (details.actualStartTime) {
    const sinceStart = now - new Date(details.actualStartTime).getTime();
    if (Number.isNaN(sinceStart) || sinceStart < 0) return false;
    if (sinceStart > LIVE_MAX_DURATION_MS) return false;
    if (details.concurrentViewers !== undefined) return true;
    return sinceStart <= LIVE_ACTUAL_START_GRACE_MS;
  }
  if (details.scheduledStartTime) {
    const elapsed = now - new Date(details.scheduledStartTime).getTime();
    if (Number.isNaN(elapsed)) return false;
    if (elapsed < -LIVE_START_GRACE_MS) return false;
    return elapsed <= LIVE_STARTUP_GRACE_MS;
  }
  return false;
}

function isValidUpcoming(video) {
  const scheduled = video.liveStreamingDetails?.scheduledStartTime;
  if (!scheduled) return false;
  const startMs = new Date(scheduled).getTime();
  if (Number.isNaN(startMs)) return false;
  const now = Date.now();
  return startMs + UPCOMING_GRACE_MS > now && startMs <= now + UPCOMING_HORIZON_MS;
}

function isRelevantUpcomingItem(item) {
  if (!item.scheduledStart) return false;
  const startMs = new Date(item.scheduledStart).getTime();
  if (Number.isNaN(startMs)) return false;
  const now = Date.now();
  return startMs + UPCOMING_GRACE_MS > now && startMs <= now + UPCOMING_HORIZON_MS;
}

function shouldCarryOverLiveItem(item) {
  const now = Date.now();
  const checkedMs = new Date(item.checkedAt || 0).getTime();
  if (!Number.isNaN(checkedMs) && now - checkedMs < LIVE_CARRY_OVER_MS) return true;
  const startMs = new Date(item.scheduledStart || 0).getTime();
  if (Number.isNaN(startMs)) return false;
  return now - startMs < 6 * 60 * 60 * 1000;
}

function buildStreamEntry(member, channelId, video) {
  const scheduledStart =
    video.liveStreamingDetails?.scheduledStartTime ||
    video.liveStreamingDetails?.actualStartTime ||
    null;
  return {
    memberKey: `${member.groupId}:${member.name}`,
    name: member.name,
    groupId: member.groupId,
    groupName: member.groupName,
    groupColor: member.groupColor,
    channelId,
    handle: member.handle || null,
    videoId: video.id,
    title: video.snippet?.title || 'タイトル未取得',
    thumbnail:
      video.snippet?.thumbnails?.medium?.url ||
      video.snippet?.thumbnails?.default?.url ||
      null,
    scheduledStart,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    checkedAt: new Date().toISOString(),
  };
}

function dedupeByMember(items, pickLater = false) {
  const map = new Map();
  for (const item of items) {
    const existing = map.get(item.memberKey);
    if (!existing) {
      map.set(item.memberKey, item);
      continue;
    }
    if (!pickLater) continue;
    const ta = new Date(item.scheduledStart || 0).getTime();
    const tb = new Date(existing.scheduledStart || 0).getTime();
    if (ta > tb) map.set(item.memberKey, item);
  }
  return [...map.values()];
}

function dedupeByVideoId(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.videoId)) map.set(item.videoId, item);
  }
  return [...map.values()];
}

function sortByScheduledStart(items) {
  return [...items].sort((a, b) => {
    const ta = new Date(a.scheduledStart || 0).getTime();
    const tb = new Date(b.scheduledStart || 0).getTime();
    const na = Number.isNaN(ta) ? Number.MAX_SAFE_INTEGER : ta;
    const nb = Number.isNaN(tb) ? Number.MAX_SAFE_INTEGER : tb;
    return na - nb;
  });
}

function mergeStatus(previous, fresh, refreshedVideoIds) {
  const liveByVideo = new Map(fresh.live.map((item) => [item.videoId, item]));
  const upcomingByVideo = new Map(fresh.upcoming.map((item) => [item.videoId, item]));
  if (previous) {
    for (const item of previous.upcoming || []) {
      if (upcomingByVideo.has(item.videoId)) continue;
      if (refreshedVideoIds.has(item.videoId)) continue;
      if (isRelevantUpcomingItem(item)) upcomingByVideo.set(item.videoId, item);
    }
  }
  return {
    updatedAt: new Date().toISOString(),
    live: dedupeByMember([...liveByVideo.values()], true).sort((a, b) =>
      a.groupName.localeCompare(b.groupName, 'ja')
    ),
    upcoming: sortByScheduledStart(dedupeByVideoId([...upcomingByVideo.values()])),
  };
}

function emptyStatus() {
  return { updatedAt: new Date().toISOString(), live: [], upcoming: [] };
}

async function loadPrevious(env) {
  const raw = await env.STATUS_KV.get(STATUS_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function refreshStatus(env) {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not set');

  const previous = (await loadPrevious(env)) || emptyStatus();
  const allMembers = flattenMembers(membersConfig.groups || []);
  const memberByChannel = new Map();
  for (const member of allMembers) {
    if (member.channelId) memberByChannel.set(member.channelId, member);
  }
  const channelIds = [...memberByChannel.keys()];
  const rssTargetIds = selectChannelsForRun(channelIds);

  const allVideoIds = [];
  let rssOk = 0;
  let rssFailed = 0;

  // 順次取得（同時多発を避け、無料枠の安定性を優先）
  for (const channelId of rssTargetIds) {
    try {
      const ids = await fetchRssVideoIds(channelId);
      rssOk += 1;
      for (const id of ids) allVideoIds.push(id);
    } catch {
      rssFailed += 1;
    }
  }

  for (const item of previous.live || []) {
    if (shouldCarryOverLiveItem(item) && item.videoId) allVideoIds.push(item.videoId);
  }
  for (const item of previous.upcoming || []) {
    if (isRelevantUpcomingItem(item) && item.videoId) allVideoIds.push(item.videoId);
  }

  const live = [];
  const upcoming = [];
  const refreshedVideoIds = new Set();
  let videosListCalls = 0;

  if (allVideoIds.length > 0) {
    videosListCalls = Math.ceil([...new Set(allVideoIds)].length / VIDEOS_LIST_CHUNK);
    const videos = await fetchVideosByIds(apiKey, allVideoIds);
    for (const video of videos) {
      refreshedVideoIds.add(video.id);
      const ownerChannelId = video.snippet?.channelId;
      const member = ownerChannelId ? memberByChannel.get(ownerChannelId) : null;
      if (!member) continue;
      const broadcast = video.snippet?.liveBroadcastContent;
      if (broadcast !== 'live' && broadcast !== 'upcoming') continue;
      const entry = buildStreamEntry(member, ownerChannelId, video);
      entry.status = broadcast;
      if (broadcast === 'live' && isValidLive(video)) live.push(entry);
      else if (isValidUpcoming(video)) upcoming.push(entry);
    }
  }

  const freshStatus = {
    updatedAt: new Date().toISOString(),
    live: dedupeByMember(live, true).sort((a, b) => a.groupName.localeCompare(b.groupName, 'ja')),
    upcoming: sortByScheduledStart(dedupeByVideoId(upcoming)),
  };
  const status = mergeStatus(previous, freshStatus, refreshedVideoIds);

  // live は TTL で表示側でも切るが、ここでは直近チェック済みだけ残す
  status.live = (status.live || []).filter((item) => {
    const checkedMs = new Date(item.checkedAt || 0).getTime();
    return !Number.isNaN(checkedMs) && Date.now() - checkedMs < LIVE_DISPLAY_TTL_MS;
  });

  await env.STATUS_KV.put(STATUS_KV_KEY, JSON.stringify(status));

  return {
    status,
    meta: {
      rssOk,
      rssFailed,
      rssBatch: rssTargetIds.length,
      channels: channelIds.length,
      videosListCalls,
      videoIds: [...new Set(allVideoIds)].length,
    },
  };
}

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function authorizeRefresh(request, env) {
  const secret = String(env.REFRESH_SECRET || '').trim();
  if (!secret) return false; // HTTP 手動更新は REFRESH_SECRET 必須（Cron は認証不要）
  const header = request.headers.get('Authorization') || '';
  let token = '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) token = bearer[1].trim();
  // 一部環境では Authorization が落ちるため、専用ヘッダーも受け付ける
  if (!token) {
    token = (request.headers.get('X-Refresh-Token') || '').trim();
  }
  const urlToken = (new URL(request.url).searchParams.get('token') || '').trim();
  return token === secret || urlToken === secret;
}

function authDebug(request, env) {
  const secret = String(env.REFRESH_SECRET || '').trim();
  const header = request.headers.get('Authorization') || '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  const bearerLen = bearer ? bearer[1].trim().length : 0;
  const xLen = (request.headers.get('X-Refresh-Token') || '').trim().length;
  const urlLen = (new URL(request.url).searchParams.get('token') || '').trim().length;
  return {
    hasSecret: Boolean(secret),
    secretLength: secret.length,
    receivedBearerLength: bearerLen,
    receivedXRefreshTokenLength: xLen,
    receivedUrlTokenLength: urlLen,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Refresh-Token',
        },
      });
    }

    if (url.pathname === '/auth-check') {
      return jsonResponse(authDebug(request, env));
    }

    if (
      (url.pathname === '/refresh' || url.pathname === '/api/refresh') &&
      (request.method === 'POST' || request.method === 'GET')
    ) {
      if (!authorizeRefresh(request, env)) {
        return jsonResponse({ error: 'unauthorized', ...authDebug(request, env) }, { status: 401 });
      }
      try {
        const result = await refreshStatus(env);
        return jsonResponse({ ok: true, ...result.meta, updatedAt: result.status.updatedAt });
      } catch (error) {
        if (error?.isQuotaExceeded) {
          return jsonResponse({ ok: false, error: 'quota_exceeded', message: error.message }, { status: 200 });
        }
        return jsonResponse({ ok: false, error: error.message }, { status: 500 });
      }
    }

    if (
      url.pathname === '/' ||
      url.pathname === '/status.json' ||
      url.pathname === '/data/status.json' ||
      url.pathname === '/api/status'
    ) {
      const raw = await env.STATUS_KV.get(STATUS_KV_KEY);
      if (!raw) return jsonResponse(emptyStatus());
      return new Response(raw, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=30',
        },
      });
    }

    return jsonResponse({ error: 'not_found' }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshStatus(env).catch((error) => {
        console.error('scheduled refresh failed', error?.message || error);
      })
    );
  },
};
