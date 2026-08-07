# VHS City 配信ダッシュボード（Cloudflare 版）

GitHub Pages / Actions 版の実験フォークです。  
**Cloudflare Pages（静的配信）+ Worker（5分更新・status 配信）** で、無料枠内運用を目指します。

元リポジトリ: https://github.com/Shohei-Tsuchiya/vhs-city-site

## 構成（無料枠向け）

```text
cron（Workers Cron */5）
  → Worker が YouTube RSS + videos.list（軽量ローテ）
  → KV に status.json を保存

ブラウザ
  → Cloudflare Pages（HTML/CSS/JS）
  → Worker URL から status.json を取得
```

| サービス | 無料枠の使い方 |
|----------|----------------|
| Pages | コード変更時だけビルド（5分ごとの再ビルドはしない） |
| Worker Cron | 5分おき（約288回/日 ≪ 10万回） |
| KV 書き込み | 約288回/日 ≪ 1,000回 |
| サブリクエスト | RSS 10ch/回 + videos.list 数回（≤50） |

※ Worker 無料は **CPU 10ms/回** が厳しいので、playlist 一括補完は入れていません。検出はローテーション中心です。

## セットアップ手順

### 0. 前提

- Cloudflare アカウント（無料）
- Node.js 22+
- このリポジトリを clone
- YouTube Data API キー（既存と同じで可）

### 1. 依存関係

```powershell
cd D:\work\dev_plugins\vhs-city-site-cf
npm install
```

### 2. KV 作成 & wrangler.toml

```powershell
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

表示された `id` を `wrangler.toml` の `id` / `preview_id` に貼る。

### 3. Worker secrets

```powershell
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put REFRESH_SECRET
```

`REFRESH_SECRET` は手動更新用（任意の長い文字列）。

### 4. Worker デプロイ

```powershell
npm run worker:deploy
```

デプロイ後の URL 例:

```text
https://vhs-city-status.<あなたのサブドメイン>.workers.dev/status.json
```

動作確認:

```powershell
curl "https://vhs-city-status.<subdomain>.workers.dev/refresh?token=<REFRESH_SECRET>"
curl "https://vhs-city-status.<subdomain>.workers.dev/status.json"
```

### 5. Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → Import Git repository
2. この `vhs-city-site-cf` を選択
3. ビルド設定:

| 項目 | 値 |
|------|-----|
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `/` |
| Root directory | `/` |

4. Environment variables（Production）:

| Name | Value |
|------|--------|
| `STATUS_WORKER_URL` | `https://vhs-city-status.<subdomain>.workers.dev` （末尾スラッシュなし） |
| `SITE_BASE_URL` | Pages の公開 URL（例: `https://vhs-city-site-cf.pages.dev`） |

5. Save and Deploy

### 6. （任意）cron-job.org バックアップ

Workers Cron が止まっているときの保険:

- URL: `https://vhs-city-status.<subdomain>.workers.dev/refresh?token=<REFRESH_SECRET>`
- 間隔: 5分
- Method: GET

## ローカル確認

```powershell
# 静的
npm run build
# index.html を開く（STATUS_WORKER_URL 未設定なら data/status.json）

# Worker
npx wrangler dev
```

## GitHub Actions について

このフォークでは **GitHub Actions / Pages は使いません。**  
更新も配信も Cloudflare 側です。

## 元サイトとの違い

- `status.json` は git に依存せず **KV** が正
- RSS は 1回あたり **10チャンネル** ローテ（無料枠のサブリクエスト対策）
- `/live` プローブや off-batch playlist は未使用（CPU/サブリクエスト節約）

問題が出たら元サイトのロジックを、無料枠の範囲で段階的に戻していきます。
