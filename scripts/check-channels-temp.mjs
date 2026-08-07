import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const members = JSON.parse(readFileSync(join(ROOT, 'data/members.json'), 'utf8'));
const cache = JSON.parse(readFileSync(join(ROOT, 'data/channel-cache.json'), 'utf8'));

async function checkHandle(handle) {
  const h = handle.replace(/^@/, '');
  const url = `https://www.youtube.com/@${encodeURIComponent(h)}`;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    const is404 =
      res.status === 404 ||
      text.includes("This page isn't available") ||
      text.includes('ページは利用できません');
    const channelMatch =
      text.match(/"channelId":"(UC[^"]+)"/) ||
      text.match(/"externalId":"(UC[^"]+)"/) ||
      text.match(/channel_id=(UC[^&"]+)/);
    const hasChannel = Boolean(channelMatch);
    return {
      ok: res.ok && !is404 && (hasChannel || res.url.includes('/@')),
      status: res.status,
      finalUrl: res.url,
      channelId: channelMatch?.[1] || null,
      is404,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkChannelId(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'VHS-City-Site/1.0' } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const results = [];
for (const group of members.groups) {
  for (const m of group.members) {
    const entry = {
      group: group.name,
      name: m.name,
      handle: m.handle || null,
      channelId: m.channelId || null,
    };
    if (m.channelId) {
      const r = await checkChannelId(m.channelId);
      entry.method = 'channelId';
      entry.resolved = r.ok;
      entry.reason = r.ok ? 'OK' : `channelId RSS failed: ${r.status || r.error}`;
    } else if (m.handle) {
      const cacheKey = m.handle.toLowerCase();
      if (cache[cacheKey]) {
        entry.method = 'cache';
        entry.resolved = true;
        entry.reason = `cached: ${cache[cacheKey]}`;
      } else {
        const r = await checkHandle(m.handle);
        entry.method = 'handle';
        entry.resolved = r.ok;
        entry.reason = r.ok
          ? `OK -> ${r.channelId || r.finalUrl}`
          : `handle @${m.handle} failed: status=${r.status ?? '?'}${r.is404 ? ' (404/unavailable)' : ''}`;
      }
    } else {
      entry.resolved = false;
      entry.reason = 'no channelId or handle';
    }
    results.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const failed = results.filter((r) => !r.resolved);
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed, all: results }, null, 2));
