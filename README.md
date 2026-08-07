# VHS City 配信ダッシュボード

VHS City メンバーの YouTube **配信中** / **配信予定** を一覧表示する非公式ファンサイトです。  
GitHub Pages で公開し、cron-job.org 経由で **5 分おき** に配信状況を更新します。

## 公開 URL（設定後）

```
https://<あなたのGitHubユーザー名>.github.io/vhs-city-site/
```

## 初回セットアップ

### 1. GitHub にリポジトリを作る

1. GitHub で **New repository** を作成
2. リポジトリ名の例: `vhs-city-site`
3. Public を選択

### 2. ローカルから push

```powershell
cd "D:\work\dev_plugins\vhs city site"
git init
git add .
git commit -m "Initial commit: VHS City stream dashboard"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/vhs-city-site.git
git push -u origin main
```

### 3. YouTube API キーを GitHub Secrets に登録

1. リポジトリの **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. Name: `YOUTUBE_API_KEY`
4. Value: Google Cloud で取得した API キー

### 4. GitHub Pages を有効化

1. **Settings** → **Pages**
2. **Build and deployment** → Source: **GitHub Actions**

### 5. 初回デプロイの確認

1. **Actions** タブで `Deploy VHS City Site` が成功するか確認
2. 数分後、Pages の URL を開く

手動で即実行する場合: Actions → `Deploy VHS City Site` → **Run workflow**

## ローカルでの動作確認

```powershell
cd "D:\work\dev_plugins\vhs city site"
copy .env.example .env
# .env に YOUTUBE_API_KEY=... を記入
npm run fetch
```

ブラウザで `index.html` を開くか、簡易サーバーで確認:

```powershell
npx --yes serve .
```

## メンバーの追加・修正

`data/members.json` を編集します。

```json
{ "name": "表示名", "channelId": "UCxxxxxxxx", "handle": "YouTubeハンドル（@なし）" }
```

**channelId は必須**です（API クォータ節約のため）。ハンドルだけの登録は避けてください。

**ビバップ高校・娯楽組** のハンドルは公式情報をもとに登録していますが、リブランディング直後のため誤りがある可能性があります。配信が拾えないメンバーがいたら YouTube の `@ハンドル` を確認して修正してください。

## API クォータについて

**search API は使わず**、RSS + `videos.list` で全メンバーを一括チェックします。

| 処理 | API 消費 |
|------|----------|
| チャンネル RSS 取得 | **0**（無料） |
| `videos.list`（最大50件/回） | **1 unit/回** |
| チャンネル ID 解決 | **0**（`members.json` に channelId 固定済み） |

現在のスケジュール:

- **cron-job.org** から `repository_dispatch` で **5 分おき** に起動（GitHub 内蔵 cron は使用しない）
- 1 回あたり `videos.list` 約 **7 回**
- 1 日あたり Queries 約 **2,000 units**（上限 9,500 に対して余裕）
- **Search Queries は 0**

### クォータ超過時の挙動

YouTube API の日次上限に達した場合:

- ワークフローは **失敗扱いにしない**（メール通知なし）
- 公開サイトは **直前のデータを維持**（デプロイもスキップ）
- 太平洋時間 0:00（JST 16:00 頃）のクォータリセット後、自動復帰

### 5 分おき更新（cron-job.org）

1. GitHub で Fine-grained PAT を作成（対象リポジトリ: `vhs-city-site`、権限: **Actions: Read and write**）
2. [cron-job.org](https://cron-job.org/) でアカウント作成
3. 新規ジョブを追加:
   - URL: `https://api.github.com/repos/Shohei-Tsuchiya/vhs-city-site/dispatches`
   - 間隔: 5 分
   - メソッド: POST
   - ヘッダー: `Authorization: Bearer <PAT>`、`Accept: application/vnd.github+json`
   - ボディ: `{"event_type":"refresh-status"}`
4. 保存後、Actions タブで **Update Stream Status** が定期実行されることを確認

手動更新は [Actions → Update Stream Status → Run workflow](https://github.com/Shohei-Tsuchiya/vhs-city-site/actions/workflows/update-status.yml) からも可能です。

### GitHub の失敗通知メールを減らす

クォータ超過時はワークフロー成功扱いになりますが、それ以外の失敗通知も減らしたい場合:

1. [GitHub → Settings → Notifications](https://github.com/settings/notifications)
2. **Actions** セクションを開く
3. **Send notifications for failed workflows** のチェックを外す（または **Only notify for failed workflows on repositories I watch** に変更）

配信状況更新は cron-job.org が担うため、GitHub cron は不要です。

配信開始からサイト反映まで、更新が正常に動いていればおおむね **5〜10 分以内** です。

## 構成

```
index.html              フロントページ
css/style.css           VHS 風スタイル
js/app.js               表示ロジック
data/members.json       メンバー定義
data/status.json        配信状況（Actions が更新）
scripts/fetch-youtube-status.mjs
.github/workflows/update-status.yml
.github/workflows/deploy.yml
```

## 免責

本サイトは **非公式のファン制作** です。株式会社 viviON および VHS City 公式とは関係ありません。
