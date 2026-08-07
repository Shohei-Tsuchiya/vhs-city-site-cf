const STATUS_URL = new URL('../data/status.json', import.meta.url);
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

let currentFilter = 'all';
let latestStatus = { live: [], upcoming: [] };

const liveList = document.getElementById('live-list');
const upcomingList = document.getElementById('upcoming-list');
const liveCount = document.getElementById('live-count');
const upcomingCount = document.getElementById('upcoming-count');
const lastUpdated = document.getElementById('last-updated');
const refreshBtn = document.getElementById('refresh-btn');
const cardTemplate = document.getElementById('stream-card-template');

const UPCOMING_GRACE_MS = 30 * 60 * 1000;
const UPCOMING_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const LIVE_DISPLAY_TTL_MS = 20 * 60 * 1000;
const DISPLAY_TZ = 'Asia/Tokyo';

const GROUP_COLORS = {
  aogiri: '#7db8ff',
  yugiri: '#ffb070',
  bebop: '#6ee7aa',
  goraku: '#c49bff',
  partner: '#f5db6e',
  official: '#9ed8df',
};

function groupLabelColor(item) {
  return GROUP_COLORS[item.groupId] || item.groupColor || '#9ec5ff';
}

function formatDateTime(iso) {
  if (!iso) return '日時未設定';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '日時未設定';

  const now = new Date();
  const yearFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: DISPLAY_TZ, year: 'numeric' });
  const showYear = yearFmt.format(date) !== yearFmt.format(now);

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: DISPLAY_TZ,
    ...(showYear ? { year: 'numeric' } : {}),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRelativeUpdate(iso) {
  if (!iso) return 'まだデータがありません（GitHub Actions の初回実行を待っています）';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  let text;
  if (minutes < 1) text = `最終更新: たった今 (${formatDateTime(iso)})`;
  else if (minutes < 60) text = `最終更新: ${minutes}分前 (${formatDateTime(iso)})`;
  else {
    const hours = Math.round(minutes / 60);
    text = `最終更新: 約${hours}時間前 (${formatDateTime(iso)})`;
  }
  if (minutes >= 10) {
    text += ' — 更新が遅れている可能性があります';
  }
  return text;
}

function filterItems(items) {
  if (currentFilter === 'all') return items;
  return items.filter((item) => item.groupId === currentFilter);
}

function scheduledStartMs(item) {
  const ms = new Date(item.scheduledStart || 0).getTime();
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

function sortByScheduledStart(items) {
  return [...items].sort((a, b) => scheduledStartMs(a) - scheduledStartMs(b));
}

function isRelevantUpcoming(item) {
  if (!item.scheduledStart) return false;
  const startMs = new Date(item.scheduledStart).getTime();
  if (Number.isNaN(startMs)) return false;
  const now = Date.now();
  return startMs + UPCOMING_GRACE_MS > now && startMs <= now + UPCOMING_HORIZON_MS;
}

function isRelevantLive(item) {
  const checkedMs = new Date(item.checkedAt || 0).getTime();
  if (Number.isNaN(checkedMs)) return false;
  return Date.now() - checkedMs < LIVE_DISPLAY_TTL_MS;
}

function renderCards(container, items, mode) {
  container.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent =
      mode === 'live'
        ? '現在配信中のメンバーはいません'
        : '配信予定は見つかりませんでした（予約していない場合もあります）';
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    const link = node.querySelector('.card-link');
    const thumb = node.querySelector('.thumb');
    const chip = node.querySelector('.status-chip');
    const groupLabel = node.querySelector('.group-label');
    const memberName = node.querySelector('.member-name');
    const streamTitle = node.querySelector('.stream-title');
    const streamTime = node.querySelector('.stream-time');

    link.href = item.url;
    thumb.src = item.thumbnail || '';
    thumb.alt = `${item.name} のサムネイル`;
    groupLabel.textContent = item.groupName;
    if (item.groupId) {
      groupLabel.dataset.groupId = item.groupId;
    }
    groupLabel.style.color = groupLabelColor(item);
    memberName.textContent = item.name;
    streamTitle.textContent = item.title || 'タイトル未取得';
    streamTime.textContent =
      mode === 'live' ? '配信中' : `開始予定: ${formatDateTime(item.scheduledStart)}`;

    chip.textContent = mode === 'live' ? 'LIVE' : 'SOON';
    chip.classList.toggle('is-live', mode === 'live');

    container.appendChild(node);
  }
}

function render() {
  const liveItems = filterItems(latestStatus.live || []).filter(isRelevantLive);
  const upcomingItems = sortByScheduledStart(
    filterItems(latestStatus.upcoming || []).filter(isRelevantUpcoming)
  );

  liveCount.textContent = String(liveItems.length);
  upcomingCount.textContent = String(upcomingItems.length);
  lastUpdated.textContent = formatRelativeUpdate(latestStatus.updatedAt);

  renderCards(liveList, liveItems, 'live');
  renderCards(upcomingList, upcomingItems, 'upcoming');
}

async function loadStatus() {
  const url = new URL(STATUS_URL);
  url.searchParams.set('t', String(Date.now()));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`status.json の読み込みに失敗しました (${response.status})`);
  }

  latestStatus = await response.json();
  render();
}

function setupFilters() {
  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((btn) => btn.classList.remove('is-active'));
      button.classList.add('is-active');
      currentFilter = button.dataset.filter;
      render();
    });
  });
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '更新中…';
  try {
    await loadStatus();
  } catch (error) {
    lastUpdated.textContent = error.message;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '再読み込み';
  }
});

setupFilters();

loadStatus().catch((error) => {
  lastUpdated.textContent = error.message;
});

setInterval(() => {
  loadStatus().catch(() => {
    /* 自動更新失敗時は表示を維持 */
  });
}, REFRESH_INTERVAL_MS);
