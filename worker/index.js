/**
 * VHS City status Worker（Cloudflare Workers 無料枠向け）
 *
 * - Cron discover（5分おき）: RSS ローテで新規発見
 * - Cron watch（5分おき・2分ずらす）: 既知の配信IDだけ再確認（軽い）
 * - GET /status.json で配信状況を返す
 *
 * 無料枠の制約:
 * - CPU 10ms/回（待ち時間の fetch は除外）
 * - サブリクエスト 50/回
 * - KV 書き込み 1,000/日 → watch+discover で約 288+288 回（watch は心跳なし）
 */

import membersConfig from '../data/members.json';

const CRON_DISCOVER = '*/5 * * * *';
const CRON_WATCH = '2-59/5 * * * *';

const RSS_CHANNELS_PER_RUN = 12;
/**
 * RSS 失敗時の playlistItems 補完上限。
 * サブリクエスト目安: RSS 12 + playlist 最大3 + videos.list 1 ≦ 50
 */
const PLAYLIST_FALLBACK_MAX = 3;
const RSS_ENTRIES_PER_CHANNEL = 4;
const VIDEOS_LIST_CHUNK = 50;
/** videos.list は1回（最大50件）に抑え、無料枠 CPU 10ms を守る */
const MAX_VIDEO_IDS_PER_RUN = 50;
const RSS_STREAM_MAX_BUFFER = 256_000;
const UPCOMING_GRACE_MS = 30 * 60 * 1000;
const UPCOMING_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const LIVE_DISPLAY_TTL_MS = 20 * 60 * 1000;
const LIVE_CARRY_OVER_MS = 3 * 60 * 60 * 1000;
const LIVE_MAX_DURATION_MS = 10 * 60 * 60 * 1000;
const STREAM_RECHECK_MS = 8 * 60 * 60 * 1000;
const LIVE_START_GRACE_MS = 10 * 60 * 1000;
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

/** 必要な videoId が揃ったら読み取りを打ち切り、大きな XML の全文パースを避ける */
async function fetchRssVideoIds(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, {
    headers: RSS_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RSS ${res.status}`);

  if (!res.body || typeof res.body.getReader !== 'function') {
    const xml = await res.text();
    return parseRssVideoIds(xml, RSS_ENTRIES_PER_CHANNEL);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const ids = [];
  try {
    while (ids.length < RSS_ENTRIES_PER_CHANNEL) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
      let match;
      let consumed = 0;
      while ((match = re.exec(buffer)) !== null) {
        ids.push(match[1]);
        consumed = match.index + match[0].length;
        if (ids.length >= RSS_ENTRIES_PER_CHANNEL) break;
      }
      if (consumed > 0) buffer = buffer.slice(consumed);
      else if (buffer.length > 8192) buffer = buffer.slice(-2048);

      if (buffer.length > RSS_STREAM_MAX_BUFFER) break;
      if (ids.length >= RSS_ENTRIES_PER_CHANNEL) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return ids.slice(0, RSS_ENTRIES_PER_CHANNEL);
}

/** uploads プレイリスト（RSS 失敗時の API フォールバック、1 unit / 1 subrequest） */
async function fetchUploadsPlaylistVideoIds(apiKey, channelId) {
  const playlistId = `UU${channelId.slice(2)}`;
  const data = await apiGet(apiKey, 'playlistItems', {
    part: 'contentDetails',
    playlistId,
    maxResults: String(Math.min(RSS_ENTRIES_PER_CHANNEL, 10)),
  });
  return (data.items || [])
    .map((item) => item.contentDetails?.videoId)
    .filter(Boolean);
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
  if (details?.actualEndTime) return false;
  if (details?.actualStartTime) {
    const sinceStart = Date.now() - new Date(details.actualStartTime).getTime();
    if (!Number.isNaN(sinceStart) && sinceStart > LIVE_MAX_DURATION_MS) return false;
  }
  return true;
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

/** 表示用 grace を過ぎても、開始前後は videos.list で配信中へ遷移したか再確認する */
function shouldRecheckKnownItem(item) {
  if (!item?.videoId) return false;
  const startMs = new Date(item.scheduledStart || 0).getTime();
  if (!Number.isNaN(startMs) && startMs > 0) {
    const now = Date.now();
    return startMs - LIVE_START_GRACE_MS <= now && now - startMs < STREAM_RECHECK_MS;
  }
  const checkedMs = new Date(item.checkedAt || 0).getTime();
  return !Number.isNaN(checkedMs) && Date.now() - checkedMs < STREAM_RECHECK_MS;
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

async function refreshStatus(env, options = {}) {
  const mode = options.mode === 'watch' ? 'watch' : 'discover';
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not set');

  const previous = (await loadPrevious(env)) || emptyStatus();
  const allMembers = flattenMembers(membersConfig.groups || []);
  const memberByChannel = new Map();
  for (const member of allMembers) {
    if (member.channelId) memberByChannel.set(member.channelId, member);
  }
  const channelIds = [...memberByChannel.keys()];
  const rssTargetIds = mode === 'discover' ? selectChannelsForRun(channelIds) : [];

  const perChannelIds = [];
  let rssOk = 0;
  let rssFailed = 0;
  let playlistFallback = 0;
  let playlistFallbackSkipped = 0;

  if (mode === 'discover') {
    // 順次取得。ストリーム打ち切り + 少数ローテで CPU を抑える
    for (const channelId of rssTargetIds) {
      try {
        const ids = await fetchRssVideoIds(channelId);
        rssOk += 1;
        perChannelIds.push(ids);
      } catch {
        rssFailed += 1;
        if (playlistFallback >= PLAYLIST_FALLBACK_MAX) {
          playlistFallbackSkipped += 1;
          continue;
        }
        try {
          const ids = await fetchUploadsPlaylistVideoIds(apiKey, channelId);
          playlistFallback += 1;
          perChannelIds.push(ids);
        } catch {
          /* このチャンネルは次のローテまでスキップ */
        }
      }
    }
  }

  const priorityIds = [];
  for (const item of previous.live || []) {
    if (shouldCarryOverLiveItem(item) && item.videoId) priorityIds.push(item.videoId);
  }
  for (const item of previous.upcoming || []) {
    // watch / discover とも、把握済みの予定は毎回再確認（開始直後の live 化を逃さない）
    if (isRelevantUpcomingItem(item) && item.videoId) priorityIds.push(item.videoId);
  }
  if (mode === 'watch') {
    for (const id of previous.meta?.watchVideoIds || []) {
      if (id) priorityIds.push(id);
    }
  }

  const uniqueVideoIds = [];
  const seenIds = new Set();
  const pushVideoId = (id) => {
    if (!id || seenIds.has(id) || uniqueVideoIds.length >= MAX_VIDEO_IDS_PER_RUN) return;
    seenIds.add(id);
    uniqueVideoIds.push(id);
  };
  for (const id of priorityIds) pushVideoId(id);
  for (let depth = 0; uniqueVideoIds.length < MAX_VIDEO_IDS_PER_RUN; depth += 1) {
    let added = false;
    for (const ids of perChannelIds) {
      if (depth < ids.length) {
        const before = uniqueVideoIds.length;
        pushVideoId(ids[depth]);
        if (uniqueVideoIds.length > before) added = true;
      }
    }
    if (!added) break;
  }

  const live = [];
  const upcoming = [];
  const refreshedVideoIds = new Set();
  let videosListCalls = 0;

  if (uniqueVideoIds.length > 0) {
    videosListCalls = Math.ceil(uniqueVideoIds.length / VIDEOS_LIST_CHUNK);
    const videos = await fetchVideosByIds(apiKey, uniqueVideoIds);
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

  const meta = {
    ok: true,
    mode,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: status.updatedAt,
    refreshStartedAt: null,
    rssOk,
    rssFailed,
    playlistFallback,
    playlistFallbackSkipped,
    rssBatch: rssTargetIds.length,
    channels: channelIds.length,
    videosListCalls,
    videoIds: uniqueVideoIds.length,
    watchVideoIds: [
      ...new Set(
        [...(status.live || []), ...(status.upcoming || [])]
          .map((item) => item.videoId)
          .filter(Boolean)
      ),
    ],
  };
  status.meta = meta;
  await env.STATUS_KV.put(STATUS_KV_KEY, JSON.stringify(status));

  return { status, meta };
}

/** Cron 開始直後に心跳だけ残す。途中終了でも「起動した」ことが分かる */
async function touchAttempt(env) {
  const previous = (await loadPrevious(env)) || emptyStatus();
  const now = new Date().toISOString();
  previous.meta = {
    ...(previous.meta || {}),
    lastAttemptAt: now,
    // Cron 起動はしたが成功前。途中終了するとここが残る
    refreshStartedAt: now,
  };
  await env.STATUS_KV.put(STATUS_KV_KEY, JSON.stringify(previous));
}

/** 取得失敗時も KV に心跳を残し、「Cron 停止」と「API 失敗」を切り分ける */
async function preserveOnFailure(env, error) {
  const previous = (await loadPrevious(env)) || emptyStatus();
  const now = new Date().toISOString();
  const status = {
    ...previous,
    meta: {
      ...(previous.meta || {}),
      ok: false,
      lastAttemptAt: now,
      lastSuccessAt: previous.meta?.lastSuccessAt || previous.updatedAt || null,
      lastError: error?.isQuotaExceeded
        ? 'quota_exceeded'
        : String(error?.message || error || 'unknown'),
      quotaExceeded: Boolean(error?.isQuotaExceeded),
    },
  };
  await env.STATUS_KV.put(STATUS_KV_KEY, JSON.stringify(status));
  return { status, meta: status.meta };
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
        const modeParam = (url.searchParams.get('mode') || 'discover').toLowerCase();
        const mode = modeParam === 'watch' ? 'watch' : 'discover';
        const result = await refreshStatus(env, { mode });
        return jsonResponse({ ok: true, ...result.meta, updatedAt: result.status.updatedAt });
      } catch (error) {
        const preserved = await preserveOnFailure(env, error);
        if (error?.isQuotaExceeded) {
          return jsonResponse(
            {
              ok: false,
              error: 'quota_exceeded',
              message: error.message,
              ...preserved.meta,
              updatedAt: preserved.status.updatedAt,
            },
            { status: 200 }
          );
        }
        return jsonResponse(
          {
            ok: false,
            error: error.message,
            ...preserved.meta,
            updatedAt: preserved.status.updatedAt,
          },
          { status: 500 }
        );
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
          'Cache-Control': 'no-store',
        },
      });
    }

    return jsonResponse({ error: 'not_found' }, { status: 404 });
  },

  async scheduled(event, env) {
    const cron = String(event.cron || '');
    const mode = cron === CRON_WATCH ? 'watch' : 'discover';
    // discover は重いので心跳を先に書く。watch は軽量のため KV 書き込みを1回に抑える
    try {
      if (mode === 'discover') await touchAttempt(env);
      await refreshStatus(env, { mode });
    } catch (error) {
      console.error(`scheduled ${mode} failed`, error?.message || error);
      try {
        await preserveOnFailure(env, error);
      } catch (preserveError) {
        console.error('preserveOnFailure failed', preserveError?.message || preserveError);
      }
    }
  },
};
