#!/usr/bin/env node
/**
 * members.json から検索エンジン向けの静的ページ・sitemap・robots.txt を生成する。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const BASE_URL = (process.env.SITE_BASE_URL || 'https://vhs-city-site-cf.pages.dev').replace(
  /\/$/,
  ''
);

const GROUP_ALIASES = {
  aogiri: ['あおぎり高校', 'Aogiri High School'],
  yugiri: ['ゆうぎり高校', 'Yugiri High School'],
  bebop: ['ビバップ高校', 'Vebop High School', 'Vebop'],
  goraku: ['娯楽組'],
  kemomimi: ['けもみみりふれっ！', 'Kemomimi Refle'],
  partner: ['パートナークリエイター', '従井ノラ'],
  official: ['VHS CITY', 'VHS City', 'VHS Cityの日常'],
};

const SITE_KEYWORDS = [
  'VHS City',
  'VHS CITY',
  'Vtuber High School City',
  '配信予定',
  '配信中',
  'YouTube',
  'VTuber',
  '非公式ファンサイト',
];

const GOOGLE_TAG_SNIPPET = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-MF18GPN7LV"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-MF18GPN7LV');
</script>`;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function memberSlug(member) {
  const handle = member.handle || '';
  if (/^[A-Za-z0-9._-]+$/.test(handle)) return handle;
  return member.channelId;
}

function memberYoutubeUrl(member) {
  const handle = member.handle || '';
  if (/^[A-Za-z0-9._-]+$/.test(handle)) {
    return `https://www.youtube.com/@${handle}`;
  }
  return `https://www.youtube.com/channel/${member.channelId}`;
}

function flattenMembers(groups) {
  return groups.flatMap((group) =>
    group.members.map((member) => ({
      ...member,
      groupId: group.id,
      groupName: group.name,
      groupColor: group.color,
      slug: memberSlug(member),
    }))
  );
}

function headMeta({ title, description, keywords, canonicalPath, depth = 0 }) {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  const canonical = `${BASE_URL}/${canonicalPath.replace(/^\//, '')}`;
  const cssHref = `${prefix}css/style.css`;
  const keywordText = [...new Set(keywords)].join(', ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
${GOOGLE_TAG_SNIPPET}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="${escapeHtml(keywordText)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:site_name" content="VHS City 配信ダッシュボード">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${cssHref}">`;
}

function pageFooter(depth = 0) {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  return `  <footer class="site-footer">
    <p>非公式ファンサイトです。viviON / VHS City 公式とは関係ありません。</p>
    <p>アクセス解析に Google Analytics を使用しています。</p>
    <p>
      <a href="${prefix}index.html">配信ダッシュボード</a>
      ·
      <a href="${prefix}members/index.html">メンバー一覧</a>
      ·
      <a href="https://vhs-city.com/" target="_blank" rel="noopener noreferrer">VHS City 公式</a>
    </p>
  </footer>
</body>
</html>`;
}

function pageShell({ title, description, keywords, canonicalPath, depth, jsonLd, mainHtml }) {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  const jsonBlock = jsonLd
    ? `\n  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
    : '';

  return `${headMeta({ title, description, keywords, canonicalPath, depth })}${jsonBlock}
</head>
<body>
  <div class="scanlines" aria-hidden="true"></div>
  <div class="vhs-noise" aria-hidden="true"></div>

  <header class="site-header seo-page-header">
    <div class="header-main">
      <p class="eyebrow">UNOFFICIAL FAN DASHBOARD</p>
      <h1><a class="seo-home-link" href="${prefix}index.html">VHS CITY 配信モニター</a></h1>
    </div>
  </header>

  <main class="seo-page">
${mainHtml}
  </main>

${pageFooter(depth)}`;
}

function writePage(relativePath, html) {
  const fullPath = join(ROOT, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${html}\n`, 'utf8');
}

function buildMemberPage(member) {
  const aliases = GROUP_ALIASES[member.groupId] || [];
  const title = `${member.name} 配信予定・配信中 | ${member.groupName} | VHS City`;
  const description = `VHS City（Vtuber High School City）${member.groupName}の${member.name}のYouTube配信予定・配信中を一覧表示。${aliases.join('、')}の配信スケジュールを非公式ファンサイトで確認できます。`;
  const keywords = [
    member.name,
    member.groupName,
    ...aliases,
    `${member.name} 配信`,
    `${member.name} 配信予定`,
    ...SITE_KEYWORDS,
  ];
  const youtubeUrl = memberYoutubeUrl(member);

  const mainHtml = `    <nav class="seo-breadcrumb" aria-label="パンくず">
      <a href="../index.html">トップ</a>
      <span aria-hidden="true"> / </span>
      <a href="../groups/${member.groupId}.html">${escapeHtml(member.groupName)}</a>
      <span aria-hidden="true"> / </span>
      <span>${escapeHtml(member.name)}</span>
    </nav>
    <article class="seo-article">
      <p class="group-label" style="color:${escapeHtml(member.groupColor)}">${escapeHtml(member.groupName)}</p>
      <h2>${escapeHtml(member.name)} の配信予定・配信中</h2>
      <p>
        <strong>${escapeHtml(member.name)}</strong>（${escapeHtml(member.groupName)} / VHS City）の
        YouTube 配信予定・配信中情報を、VHS City 配信ダッシュボードで確認できます。
        ${aliases.length ? `${aliases.map((a) => escapeHtml(a)).join('、')} に所属する VTuber ${escapeHtml(member.name)} の配信スケジュール検索用ページです。` : ''}
      </p>
      <ul class="seo-links">
        <li><a href="../index.html">配信ダッシュボードで ${escapeHtml(member.name)} の配信を見る</a></li>
        <li><a href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(member.name)} の YouTube チャンネル</a></li>
        <li><a href="../groups/${member.groupId}.html">${escapeHtml(member.groupName)} メンバー一覧</a></li>
      </ul>
    </article>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    name: `${member.name} 配信予定 | VHS City`,
    description,
    url: `${BASE_URL}/members/${member.slug}.html`,
    mainEntity: {
      '@type': 'Person',
      name: member.name,
      url: youtubeUrl,
      memberOf: {
        '@type': 'Organization',
        name: member.groupName,
      },
    },
  };

  writePage(
    `members/${member.slug}.html`,
    pageShell({
      title,
      description,
      keywords,
      canonicalPath: `members/${member.slug}.html`,
      depth: 1,
      jsonLd,
      mainHtml,
    })
  );

  return `${BASE_URL}/members/${member.slug}.html`;
}

function buildGroupPage(group, members) {
  const aliases = GROUP_ALIASES[group.id] || [];
  const memberNames = members.map((m) => m.name).join('、');
  const title = `${group.name} 配信予定・配信中 | VHS City`;
  const description = `VHS City（Vtuber High School City）${group.name}（${aliases.join(' / ') || group.name}）のメンバー配信予定・配信中一覧。${memberNames} などの YouTube 配信スケジュールを確認できます。`;
  const keywords = [group.name, ...aliases, ...members.map((m) => m.name), ...SITE_KEYWORDS];

  const memberLinks = members
    .map(
      (member) =>
        `        <li><a href="../members/${member.slug}.html">${escapeHtml(member.name)}</a> — ${escapeHtml(member.name)} 配信予定・配信中</li>`
    )
    .join('\n');

  const mainHtml = `    <nav class="seo-breadcrumb" aria-label="パンくず">
      <a href="../index.html">トップ</a>
      <span aria-hidden="true"> / </span>
      <span>${escapeHtml(group.name)}</span>
    </nav>
    <article class="seo-article">
      <p class="group-label" style="color:${escapeHtml(group.color)}">VHS City</p>
      <h2>${escapeHtml(group.name)} 配信予定・配信中</h2>
      <p>
        <strong>${escapeHtml(group.name)}</strong>（${escapeHtml(aliases.join(' / ') || group.name)}）は
        VHS City（Vtuber High School City）に所属する VTuber グループです。
        このページでは ${escapeHtml(memberNames)} の配信予定・配信中情報への入口をまとめています。
      </p>
      <h3>${escapeHtml(group.name)} メンバー</h3>
      <ul class="seo-member-list">
${memberLinks}
      </ul>
      <p><a class="btn-ghost seo-cta" href="../index.html">${escapeHtml(group.name)} の配信をダッシュボードで見る</a></p>
    </article>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: `${BASE_URL}/groups/${group.id}.html`,
    about: {
      '@type': 'Organization',
      name: group.name,
      alternateName: aliases,
    },
  };

  writePage(
    `groups/${group.id}.html`,
    pageShell({
      title,
      description,
      keywords,
      canonicalPath: `groups/${group.id}.html`,
      depth: 1,
      jsonLd,
      mainHtml,
    })
  );

  return `${BASE_URL}/groups/${group.id}.html`;
}

function buildMembersIndex(groups, allMembers) {
  const sections = groups
    .map((group) => {
      const members = allMembers.filter((m) => m.groupId === group.id);
      const items = members
        .map(
          (member) =>
            `          <li><a href="${member.slug}.html">${escapeHtml(member.name)}</a>（${escapeHtml(group.name)}）</li>`
        )
        .join('\n');
      return `      <section class="seo-group-block">
        <h3><a href="../groups/${group.id}.html">${escapeHtml(group.name)}</a></h3>
        <ul class="seo-member-list">
${items}
        </ul>
      </section>`;
    })
    .join('\n');

  const allNames = allMembers.map((m) => m.name).join('、');
  const title = 'VHS City メンバー一覧 | 配信予定・配信中';
  const description = `VHS City（Vtuber High School City）所属メンバー ${allNames} の配信予定・配信中一覧。あおぎり高校、ゆうぎり高校、ビバップ高校、娯楽組、従井ノラなどの YouTube 配信スケジュールを検索できます。`;

  const mainHtml = `    <article class="seo-article">
      <h2>VHS City メンバー一覧</h2>
      <p>
        VHS City（VHS CITY / Vtuber High School City）の VTuber メンバー全員の
        配信予定・配信中ページです。グループ名・タレント名で検索された方は、該当メンバーを選んでください。
      </p>
      <p><a class="btn-ghost seo-cta" href="../index.html">配信ダッシュボードへ</a></p>
    </article>
    <div class="seo-directory-grid">
${sections}
    </div>`;

  writePage(
    'members/index.html',
    pageShell({
      title,
      description,
      keywords: [...SITE_KEYWORDS, 'メンバー一覧', ...allMembers.map((m) => m.name)],
      canonicalPath: 'members/index.html',
      depth: 1,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        description,
        url: `${BASE_URL}/members/index.html`,
      },
      mainHtml,
    })
  );

  return `${BASE_URL}/members/index.html`;
}

function buildSitemap(urls) {
  const lastmod = new Date().toISOString().slice(0, 10);
  const uniqueUrls = [...new Set(urls)];
  const body = uniqueUrls
    .map((loc) => {
      const isHome = loc.endsWith('/') || loc.endsWith('/index.html');
      const isMember = loc.includes('/members/');
      const priority = isHome ? '1.0' : isMember ? '0.8' : '0.9';
      return `  <url>
    <loc>${escapeHtml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${priority}</priority>
  </url>`;
    })
    .join('\n');

  // UTF-8 without BOM — GitHub Pages / Googlebot 互換性のため
  writeFileSync(
    join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`,
    'utf8'
  );

  // Search Console が XML を取れない場合の代替（Google はテキスト sitemap も受理）
  writeFileSync(join(ROOT, 'sitemap.txt'), `${uniqueUrls.join('\n')}\n`, 'utf8');
}

function buildRobotsTxt() {
  writeFileSync(
    join(ROOT, 'robots.txt'),
    `User-agent: *
Allow: /

Sitemap: ${BASE_URL}/sitemap.xml
Sitemap: ${BASE_URL}/sitemap.txt
`,
    'utf8'
  );
}

function main() {
  const config = JSON.parse(readFileSync(join(DATA, 'members.json'), 'utf8'));
  const allMembers = flattenMembers(config.groups);
  const urls = [`${BASE_URL}/`, `${BASE_URL}/index.html`];

  mkdirSync(join(ROOT, 'members'), { recursive: true });
  mkdirSync(join(ROOT, 'groups'), { recursive: true });

  urls.push(buildMembersIndex(config.groups, allMembers));

  for (const group of config.groups) {
    const members = allMembers.filter((m) => m.groupId === group.id);
    urls.push(buildGroupPage(group, members));
  }

  for (const member of allMembers) {
    urls.push(buildMemberPage(member));
  }

  buildSitemap(urls);
  buildRobotsTxt();

  console.log(
    `SEO generated: ${allMembers.length} member pages, ${config.groups.length} group pages, sitemap (${urls.length} URLs)`
  );
}

main();
