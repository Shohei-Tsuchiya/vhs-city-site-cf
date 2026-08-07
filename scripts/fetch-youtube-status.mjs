#!/usr/bin/env node
/**
 * YouTube 配信状況を取得し data/status.json を更新する。
 * RSS で最新動画 ID を取得し、videos.list で一括判定（search API 不使用）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');

const API_KEY = process.env.YOUTUBE_API_KEY;
const RSS_ENTRIES_PER_CHANNEL = Number(process.env.RSS_ENTRIES_PER_CHANNEL || 10);
const RSS_CONCURRENCY = Number(process.env.RSS_CONCURRENCY || 1);
const RSS_RETRY_COUNT = Number(process.env.RSS_RETRY_COUNT || 3);
// GitHub Actions から全件叩くと YouTube RSS が 404/500 になりやすいためローテーション
const RSS_CHANNELS_PER_RUN = Number(process.env.RSS_CHANNELS_PER_RUN || 18);
const RSS_DELAY_MS = Number(process.env.RSS_DELAY_MS || 800);
const LIVE_PROBE_ENABLED = process.env.LIVE_PROBE_ENABLED !== '0';
const STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ENTRY_RECENT_MS = 30 * 60 * 1000;
const LIVE_DISPLAY_TTL_MS = 20 * 60 * 1000;
const LIVE_CARRY_OVER_MS = 3 * 60 * 60 * 1000;
const UPCOMING_GRACE_MS = 30 * 60 * 1000;
const UPCOMING_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const VIDEOS_LIST_CHUNK = 50;

const RSS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/atom+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
};

if (!API_KEY) {
  console.error('YOUTUBE_API_KEY が設定されていません');
  process.exit(1);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

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

async function apiGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('key', API_KEY);

  const res = await fetch(url);
  const body = await res.json();

  if (!res.ok) {
    const message = body?.error?.message || res.statusText;
    const error = new Error(`YouTube API error (${endpoint}): ${message}`);
    if (/quota/i.test(message)) {
      error.isQuotaExceeded = true;
    }
    throw error;
  }

  return body;
}

function isQuotaExceeded(error) {
  return Boolean(error?.isQuotaExceeded || /quota/i.test(error?.message || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamCount(status) {
  if (!status) return 0;
  return (status.live?.length || 0) + (status.upcoming?.length || 0);
}

function statusAgeMs(status) {
  const ms = new Date(status?.updatedAt || 0).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : Date.now() - ms;
}

function isStatusRecentEnough(status) {
  return statusAgeMs(status) <= STATUS_MAX_AGE_MS;
}

function isRelevantLiveItem(item) {
  const checkedMs = new Date(item.checkedAt || 0).getTime();
  if (Number.isNaN(checkedMs)) return false;
  return Date.now() - checkedMs < LIVE_DISPLAY_TTL_MS;
}

function shouldCarryOverLiveItem(item) {
  const now = Date.now();
  const checkedMs = new Date(item.checkedAt || 0).getTime();
  if (!Number.isNaN(checkedMs) && now - checkedMs < LIVE_CARRY_OVER_MS) return true;
  const startMs = new Date(item.scheduledStart || 0).getTime();
  if (Number.isNaN(startMs)) return false;
  return now - startMs < 6 * 60 * 60 * 1000;
}

function isRelevantUpcomingItem(item) {
  if (!item.scheduledStart) return false;
  const startMs = new Date(item.scheduledStart).getTime();
  if (Number.isNaN(startMs)) return false;
  const now = Date.now();
  return startMs + UPCOMING_GRACE_MS > now && startMs <= now + UPCOMING_HORIZON_MS;
}

function sanitizeStatus(status) {
  if (!status) return { updatedAt: new Date().toISOString(), live: [], upcoming: [] };

  const live = (status.live || []).filter(isRelevantLiveItem);
  const upcoming = (status.upcoming || []).filter(isRelevantUpcomingItem);

  return {
    ...status,
    live,
    upcoming: sortByScheduledStart(upcoming),
  };
}

function markDeploySkipped(reason) {
  writeFileSync(join(ROOT, '.deploy-skipped'), `${new Date().toISOString()}\n${reason}\n`, 'utf8');
}

async function loadPreviousStatus() {
  const cached = readJson(join(DATA, 'status.json'), null);
  if (cached) {
    const sanitized = sanitizeStatus(cached);
    if (streamCount(sanitized) > 0) {
      console.log(`Using cached status (updatedAt: ${cached.updatedAt})`);
      return sanitized;
    }
  }

  const fallbackUrl =
    process.env.STATUS_FALLBACK_URL ||
    'https://shohei-tsuchiya.github.io/vhs-city-site/data/status.json';

  try {
    const res = await fetch(fallbackUrl, {
      headers: { 'User-Agent': RSS_HEADERS['User-Agent'] },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const remote = await res.json();
    const sanitized = sanitizeStatus(remote);
    if (streamCount(sanitized) > 0) {
      console.log(`Using live site status (updatedAt: ${remote.updatedAt})`);
      return sanitized;
    }

    console.warn(`Live site status has no active streams (updatedAt: ${remote.updatedAt})`);
  } catch (error) {
    console.warn(`Could not load live status fallback: ${error.message}`);
  }

  return null;
}

function memberFromStatusItem(item) {
  return {
    groupId: item.groupId,
    name: item.name,
    groupName: item.groupName,
    groupColor: item.groupColor,
    handle: item.handle,
  };
}

function buildCarryOver(previous) {
  const videoIds = [];
  const mapping = new Map();
  if (!previous) return { videoIds, mapping };

  const addItem = (item) => {
    if (!item?.videoId || !item.channelId || mapping.has(item.videoId)) return;
    videoIds.push(item.videoId);
    mapping.set(item.videoId, {
      member: memberFromStatusItem(item),
      channelId: item.channelId,
    });
  };

  for (const item of previous.live || []) {
    if (shouldCarryOverLiveItem(item)) addItem(item);
  }
  for (const item of previous.upcoming || []) {
    if (isRelevantUpcomingItem(item)) addItem(item);
  }

  return { videoIds, mapping };
}

function selectChannelsForRun(channelIds) {
  // 全チャンネルを毎回見る（RSS は API クォータを消費しない）。
  // チャンネル数が上限を超える場合のみローテーション。
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

function preserveAndSkipDeploy(previousStatus, reason) {
  markDeploySkipped(reason);

  if (previousStatus) {
    writeJson(join(DATA, 'status.json'), previousStatus);
    console.warn(
      `Keeping previous status (updatedAt: ${previousStatus.updatedAt}). ${reason}`
    );
    return true;
  }

  console.warn(`No previous status to keep. ${reason}`);
  return false;
}

function preservePreviousStatus(reason) {
  const existing = readJson(join(DATA, 'status.json'), null);
  return preserveAndSkipDeploy(existing, reason);
}

async function resolveChannelId(member, cache) {
  if (member.channelId) return member.channelId;
  if (!member.handle) return null;

  const cacheKey = member.handle.toLowerCase();
  if (cache[cacheKey]) return cache[cacheKey];

  const handle = member.handle.replace(/^@/, '');
  const data = await apiGet('channels', {
    part: 'id',
    forHandle: handle,
  });

  const channelId = data.items?.[0]?.id;
  if (channelId) {
    cache[cacheKey] = channelId;
  }
  return channelId;
}

function parseRssVideoIds(xml, limit) {
  const ids = [];
  const regex = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let match;
  while ((match = regex.exec(xml)) !== null && ids.length < limit) {
    ids.push(match[1]);
  }
  return ids;
}

async function fetchRssVideoIds(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let lastError;

  for (let attempt = 0; attempt <= RSS_RETRY_COUNT; attempt += 1) {
    if (attempt > 0) {
      await sleep(400 * attempt);
    }

    try {
      const res = await fetch(url, {
        headers: RSS_HEADERS,
      });

      if (!res.ok) {
        throw new Error(`RSS fetch failed (${res.status})`);
      }

      const xml = await res.text();
      return parseRssVideoIds(xml, RSS_ENTRIES_PER_CHANNEL);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** uploads プレイリストから最新動画 ID を取得（RSS 失敗時の API フォールバック、1 unit） */
async function fetchUploadsPlaylistVideoIds(channelId) {
  const playlistId = `UU${channelId.slice(2)}`;
  const data = await apiGet('playlistItems', {
    part: 'contentDetails',
    playlistId,
    maxResults: String(Math.min(RSS_ENTRIES_PER_CHANNEL, 10)),
  });
  return (data.items || [])
    .map((item) => item.contentDetails?.videoId)
    .filter(Boolean);
}

/**
 * /live HTML / リダイレクトから候補 videoId を取る。
 * 最終的なメンバー帰属は videos.list の snippet.channelId で行う（ここは候補集めのみ）。
 */
async function fetchCurrentLiveVideoId(channelId, handle = null) {
  const candidates = [];
  if (handle && /^[A-Za-z0-9._-]+$/.test(handle)) {
    candidates.push(`https://www.youtube.com/@${handle.replace(/^@/, '')}/live`);
  }
  candidates.push(`https://www.youtube.com/channel/${channelId}/live`);

  for (const url of candidates) {
    try {
      // リダイレクト先は GHA から別chの配信に飛ぶことがあるため follow しない
      const res = await fetch(url, {
        headers: {
          ...RSS_HEADERS,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      });

      const location = res.headers.get('location') || '';
      const fromLocation = location.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (fromLocation) return fromLocation[1];

      if (res.status >= 300 && res.status < 400) continue;
      if (!res.ok) continue;

      const html = await res.text();
      if (/LIVE_STREAM_OFFLINE/.test(html) && !/"isLiveNow"\s*:\s*true/.test(html)) {
        continue;
      }

      const ownedPair = html.match(
        new RegExp(
          `"videoId"\\s*:\\s*"([a-zA-Z0-9_-]{11})"\\s*,\\s*"channelId"\\s*:\\s*"${channelId}"|"channelId"\\s*:\\s*"${channelId}"\\s*,\\s*"videoId"\\s*:\\s*"([a-zA-Z0-9_-]{11})"`
        )
      );
      if (ownedPair?.[1] || ownedPair?.[2]) return ownedPair[1] || ownedPair[2];

      const canonical = html.match(
        /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/i
      ) || html.match(
        /href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"[^>]*rel="canonical"/i
      );
      if (canonical) return canonical[1];
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function mapPool(items, concurrency, mapper) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(mapper));
    results.push(...chunkResults);
    if (i + concurrency < items.length && RSS_DELAY_MS > 0) {
      await sleep(RSS_DELAY_MS);
    }
  }
  return results;
}

async function fetchVideosByIds(videoIds) {
  const uniqueIds = [...new Set(videoIds)];
  const videos = [];

  for (let i = 0; i < uniqueIds.length; i += VIDEOS_LIST_CHUNK) {
    const chunk = uniqueIds.slice(i, i + VIDEOS_LIST_CHUNK);
    const data = await apiGet('videos', {
      part: 'snippet,liveStreamingDetails,status',
      id: chunk.join(','),
    });
    videos.push(...(data.items || []));
  }

  return videos;
}

const LIVE_START_GRACE_MS = 10 * 60 * 1000;
const LIVE_MAX_DURATION_MS = 10 * 60 * 60 * 1000;
// concurrentViewers 未返却時に配信中とみなす最大時間（終了済みの誤判定を防ぐ）
const LIVE_STARTUP_GRACE_MS = 45 * 60 * 1000;
const LIVE_ACTUAL_START_GRACE_MS = 20 * 60 * 1000;

function isValidLive(video) {
  if (video.snippet?.liveBroadcastContent !== 'live') return false;

  const details = video.liveStreamingDetails;
  if (!details) return false;
  if (details.actualEndTime) return false;

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
  // 開始予定を過ぎても未開始の予約は YouTube 側で upcoming のまま残ることがある
  // 90日超の常設スケジュール枠（Free Chat 等）は近い予定ではないため除外
  return startMs + UPCOMING_GRACE_MS > now && startMs <= now + UPCOMING_HORIZON_MS;
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

async function main() {
  const membersConfig = readJson(join(DATA, 'members.json'), { groups: [] });
  const allMembers = flattenMembers(membersConfig.groups);
  const channelCache = readJson(join(DATA, 'channel-cache.json'), {});
  const previousStatus = await loadPreviousStatus();

  if (allMembers.length === 0) {
    console.log('メンバーが登録されていません');
    return;
  }

  const memberByChannel = new Map();
  const videoToMember = new Map();
  let channelResolveCalls = 0;
  let rssOk = 0;
  let rssFailed = 0;

  for (const member of allMembers) {
    let channelId;
    try {
      const hadCache =
        Boolean(member.channelId) ||
        Boolean(member.handle && channelCache[member.handle.toLowerCase()]);
      channelId = await resolveChannelId(member, channelCache);
      if (!hadCache && channelId) channelResolveCalls += 1;
    } catch (error) {
      if (isQuotaExceeded(error)) throw error;
      console.warn(`Channel resolve failed for ${member.name}: ${error.message}`);
      continue;
    }

    if (!channelId) {
      console.warn(`Channel ID not found for ${member.name} (@${member.handle})`);
      continue;
    }

    memberByChannel.set(channelId, member);
  }

  const channelIds = [...memberByChannel.keys()];
  console.log(`Resolved ${channelIds.length} channel(s)`);

  const rssTargetIds = selectChannelsForRun(channelIds);
  console.log(`RSS batch: ${rssTargetIds.length}/${channelIds.length} channel(s)`);

  let playlistFallbackCalls = 0;
  let liveProbeHits = 0;
  const rssResults = await mapPool(rssTargetIds, RSS_CONCURRENCY, async (channelId) => {
    const member = memberByChannel.get(channelId);
    try {
      const videoIds = await fetchRssVideoIds(channelId);
      rssOk += 1;
      return { channelId, member, videoIds };
    } catch (error) {
      rssFailed += 1;
      console.warn(`RSS failed for ${member.name}: ${error.message}`);
      try {
        const videoIds = await fetchUploadsPlaylistVideoIds(channelId);
        playlistFallbackCalls += 1;
        console.log(`API fallback OK for ${member.name}: ${videoIds.length} video(s)`);
        return { channelId, member, videoIds };
      } catch (fallbackError) {
        console.warn(`API fallback failed for ${member.name}: ${fallbackError.message}`);
        return { channelId, member, videoIds: [] };
      }
    }
  });

  const carryOver = buildCarryOver(previousStatus);
  console.log(`Carry-over: ${carryOver.videoIds.length} video(s) from previous status`);

  const allVideoIds = [];
  for (const { channelId, member, videoIds } of rssResults) {
    for (const videoId of videoIds) {
      allVideoIds.push(videoId);
      if (!videoToMember.has(videoId)) {
        videoToMember.set(videoId, { member, channelId });
      }
    }
  }

  for (const videoId of carryOver.videoIds) {
    if (!videoToMember.has(videoId)) {
      videoToMember.set(videoId, carryOver.mapping.get(videoId));
    }
    if (!allVideoIds.includes(videoId)) {
      allVideoIds.push(videoId);
    }
  }

  // RSS 対象外は uploads プレイリストで補完（/live リダイレクトは GHA から別chに飛ぶため非信頼）
  const rssSet = new Set(rssTargetIds);
  const offBatchIds = channelIds.filter((id) => !rssSet.has(id));
  for (const channelId of offBatchIds) {
    const member = memberByChannel.get(channelId);
    try {
      const videoIds = await fetchUploadsPlaylistVideoIds(channelId);
      playlistFallbackCalls += 1;
      for (const videoId of videoIds) {
        allVideoIds.push(videoId);
        if (!videoToMember.has(videoId)) {
          videoToMember.set(videoId, { member, channelId });
        }
      }
    } catch (error) {
      console.warn(`Off-batch playlist failed for ${member.name}: ${error.message}`);
      if (LIVE_PROBE_ENABLED) {
        const liveVideoId = await fetchCurrentLiveVideoId(channelId, member.handle);
        if (liveVideoId) {
          liveProbeHits += 1;
          console.log(`Live probe hit: ${member.name} -> ${liveVideoId}`);
          if (!videoToMember.has(liveVideoId)) {
            videoToMember.set(liveVideoId, { member, channelId });
          }
          if (!allVideoIds.includes(liveVideoId)) {
            allVideoIds.push(liveVideoId);
          }
        }
      }
    }
    if (RSS_DELAY_MS > 0) await sleep(Math.min(RSS_DELAY_MS, 200));
  }

  console.log(
    `RSS: ok=${rssOk}, failed=${rssFailed}, playlistFallback=${playlistFallbackCalls}, liveProbeHits=${liveProbeHits}, videoIds=${allVideoIds.length}`
  );

  const live = [];
  const upcoming = [];
  const refreshedVideoIds = new Set();
  let videosListCalls = 0;

  if (allVideoIds.length > 0) {
    videosListCalls = Math.ceil(allVideoIds.length / VIDEOS_LIST_CHUNK);
    const videos = await fetchVideosByIds(allVideoIds);

    for (const video of videos) {
      refreshedVideoIds.add(video.id);
      const ownerChannelId = video.snippet?.channelId;
      // 動画の実際の所有者チャンネルで帰属（プローブ誤検出の取り違え防止）
      const member = ownerChannelId ? memberByChannel.get(ownerChannelId) : null;
      if (!member) {
        const mapping = videoToMember.get(video.id);
        if (mapping && ownerChannelId && ownerChannelId !== mapping.channelId) {
          console.warn(
            `Skip channel mismatch: video=${video.id} owner=${ownerChannelId} mapped=${mapping.channelId} (${mapping.member.name})`
          );
        }
        continue;
      }

      const broadcast = video.snippet?.liveBroadcastContent;
      if (broadcast !== 'live' && broadcast !== 'upcoming') continue;

      const entry = buildStreamEntry(member, ownerChannelId, video);
      entry.status = broadcast;

      if (broadcast === 'live' && isValidLive(video)) {
        live.push(entry);
      } else if (isValidUpcoming(video)) {
        upcoming.push(entry);
      }
    }
  }

  const freshStatus = {
    updatedAt: new Date().toISOString(),
    live: dedupeByMember(live, true).sort((a, b) => a.groupName.localeCompare(b.groupName, 'ja')),
    upcoming: sortByScheduledStart(dedupeByVideoId(upcoming)),
  };

  const status = mergeStatus(previousStatus, freshStatus, refreshedVideoIds);

  writeJson(join(DATA, 'channel-cache.json'), channelCache);
  writeJson(join(DATA, 'status.json'), status);

  const queriesThisRun = channelResolveCalls + videosListCalls + playlistFallbackCalls;
  console.log(
    `Done. live=${status.live.length}, upcoming=${status.upcoming.length}, apiCalls=${queriesThisRun} (channels=${channelResolveCalls}, videos.list=${videosListCalls}, playlistFallback=${playlistFallbackCalls}), merged=${Boolean(previousStatus)}`
  );
}

main().catch((error) => {
  if (isQuotaExceeded(error)) {
    preservePreviousStatus(error.message);
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
