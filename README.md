# LINE Group PDF Archive

LINEグループに投稿されたPDF/ファイルとURLを、Google Driveへ保存し、Markdown索引 `references.md` に自動追記するMVPです。

## 現在できること

- LINE Messaging APIのWebhookを受け取る
- LINEに投稿されたファイルをダウンロードする
- PDF/ファイルをGoogle Driveの `files/` に保存する
- テキストメッセージ内のURLを検出する
- URL先の本文を抽出し、Google Driveの `web/` にMarkdownスナップショットとして保存する
- PDF/URL本文をOpenAI APIで日本語要約する
- Google Drive上の `references.md` に投稿日時、投稿者、保存先、要約、タグを追記する
- Drive/OAuthの疎通確認コマンドを実行する

## 保存形式

Google Driveには以下の構成を作ります。

```text
LINE資料アーカイブ/
  references.md       # 一覧Markdown（1資料1カード）
  資料ダッシュボード     # Googleスプレッドシート（1資料1行・並べ替え/検索可）
  files/
    2026-06/
      2026-06-27_PDF_糖尿病診療ガイドラインの外来管理.pdf
  web/
    2026-06/
      2026-06-27_URL_抗菌薬選択の初期対応.md
```

保存ファイル名は以下の規則に寄せています。

```text
YYYY-MM-DD_URL_内容ラベル.md
YYYY-MM-DD_PDF_内容ラベル.pdf
YYYY-MM-DD_FILE_内容ラベル.<拡張子>
```

`内容ラベル` は要約の先頭要点を優先し、要約できない場合は元タイトル/元ファイル名から作ります。フォルダは日本時間の月単位で分けます。

`references.md` は時系列の追記型です。

```md
## 2026-06-27

### URL: example article

- 投稿日時: 2026-06-27T13:25:00.000Z
- 投稿者: Uxxxxxxxx
- グループ: Cxxxxxxxx
- 元URL: https://example.com/...
- 保存先: https://drive.google.com/...
- タグ: #感染症 #救急
- 要約:
  - ...
```

## セットアップ

```bash
npm install
cp .env.example .env
```

`.env` に以下を設定します。秘密値はREADMEやチャットに貼らないでください。

```env
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=

# プロバイダが1個だけ持つGoogle OAuthアプリ（Webアプリ型）
GOOGLE_OAUTH_CLIENT_JSON=
# 接続リンクとOAuthリダイレクトのベースURL（ローカルはngrokのURL）
PUBLIC_BASE_URL=

# テナントストア（パイロットはJSONファイル）と暗号鍵（openssl rand -hex 32）
TENANT_STORE_PATH=data/tenants.json
TENANT_ENCRYPTION_KEY=

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

# 無料枠（テナントごと・月あたりの要約/保存件数, JST）
FREE_MONTHLY_LIMIT=50

PORT=3000
```

このシステムは**マルチテナント**です。1つのLINE公式アカウントを各グループが
追加し、グループごとに**自分のGoogle Drive**を接続します。各先生はGoogle Cloud
Consoleを触らず、同意画面で「許可」を1回押すだけです。設計の詳細は
[docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md) を参照してください。

Google OAuthクライアントは**Webアプリ型**で作成し、承認済みリダイレクトURIに
`<PUBLIC_BASE_URL>/oauth/callback` を登録します。スコープは `drive.file`
（アプリが作成したファイルのみ）で、審査負荷を抑えます。

## グループの接続フロー

各グループ（テナント）は次の操作だけで自分のDriveに接続します。

1. LINE公式アカウントをグループに追加する。
2. Botがチャットに出す接続リンクをタップする（出ない場合はグループで「/接続」と送信）。
3. Googleの同意画面で「許可」を押す。

これでアプリが各ユーザーのDrive内に「LINE資料アーカイブ」フォルダと
`references.md` を作成し、以降の投稿を自動保存します。Cloud Consoleの操作は不要です。

## プロバイダ側の設定確認

デプロイ前に、共有設定（OAuthクライアント・リダイレクトURI・ストア書き込み）を確認します。

```bash
npm run check:drive
```

成功例:

```text
oauth_client ok
redirect_uri https://<PUBLIC_BASE_URL>/oauth/callback
tenant_store writable data/tenants.json
check ok
```

## 起動

```bash
npm run dev
```

ローカルサーバーは以下で待機します。

```text
http://localhost:3000
```

外部公開にはngrokなどを使います。

```bash
ngrok http 3000
```

LINE DevelopersのWebhook URLには、ngrokのURLそのものではなく、必ず `/line/webhook` まで含めます。

```text
https://<ngrokの公開URL>/line/webhook
```

確認用URL:

```text
https://<ngrokの公開URL>/healthz
https://<ngrokの公開URL>/line/webhook
```

## npm scripts

```bash
npm run dev          # 開発サーバー起動
npm run build        # TypeScriptビルド
npm run typecheck    # 型チェック
npm run check:drive  # プロバイダ設定の事前確認
npm run google:auth  # 旧・単一テナント用のトークン発行（現フローでは未使用）
```

## 今日の作業ログ

2026-06-28時点のMVP構築・改善ログです。

- LINE Webhook受信サーバーを追加
- LINE署名検証を追加
- PDF/ファイル投稿のダウンロード処理を追加
- URL抽出とWeb本文抽出を追加
- Google Drive保存処理を追加
- `references.md` へのMarkdown追記処理を追加
- OpenAI APIによる要約・タグ生成を追加
- `.env.example` と `.gitignore` を追加
- Google Driveのサービスアカウント方式で `storageQuotaExceeded` に当たったため、個人Drive向けにOAuth方式へ切り替え
- `npm run google:auth` を追加
- `npm run check:drive` を追加
- Google Drive API未有効時の長いエラーを短い診断ログに変更
- OpenAI APIエラー時も保存処理全体が止まらないように変更
- APIキーがログに出ないようにマスク処理を追加
- `.env` より親シェルの古い `OPENAI_API_KEY` が優先される問題を修正し、`.env` を優先するように変更
- Google Docs形式の `references.md` が重複作成される問題を修正
- 正しい `text/markdown` の `references.md` を `GOOGLE_DRIVE_INDEX_FILE_ID` で固定
- ブラウザ確認しやすいように `/` と `GET /line/webhook` の診断レスポンスを追加
- 保存ファイル名を `日付_種別_内容ラベル` 形式に変更
- Google Driveの保存先を `files/YYYY-MM/` と `web/YYYY-MM/` に月別分割

## トラブルシュート

### Webhook URLが404になる

LINE Developersに設定するURLに `/line/webhook` が含まれているか確認します。

```text
https://<公開URL>/line/webhook
```

### Google Drive APIが無効

`Google Drive API has not been used...` が出る場合は、Google Cloud ConsoleでGoogle Drive APIを有効化します。

### Service Accounts do not have storage quota

個人用マイドライブにサービスアカウントで新規ファイルを作ろうとした状態です。OAuth方式を使います。

### redirect_uri_mismatch

OAuthクライアントがWebアプリ型になっているか、リダイレクトURIが一致していません。デスクトップアプリ型OAuthクライアントを作るのが簡単です。

### access_denied

OAuth同意画面がテスト中の場合、ログインするGoogleアカウントをテストユーザーに追加します。

### OpenAI API keyが古い値で読まれる

親シェルに古い `OPENAI_API_KEY` が残っている可能性があります。現在のコードは `.env` を優先して読みます。変更後はサーバーを再起動します。

```bash
Ctrl-C
npm run dev
```

### references.mdが複数できる

古いコードでGoogle Docs形式の `references.md` が作られた可能性があります。今後は `.env` の `GOOGLE_DRIVE_INDEX_FILE_ID` に固定した通常Markdownファイルだけを使います。

Google Drive上では、Google Docsアイコンの古い `references.md` は削除して構いません。残すのは通常ファイルの `text/markdown` の方です。

## 既知の制限

- Botがグループに参加する前の過去ログは取得できません
- スキャンPDFのOCRは未実装です
- 長いPDFは先頭側の本文だけを要約します
- URL先がログイン必須、JavaScript依存、取得拒否の場合は本文抽出に失敗することがあります
- ngrok無料URLは変わるため、本運用では常設デプロイが必要です
- 同じURL/同じLINEイベントの重複投稿対策は未実装です
- 送信取消イベントへの反映は未実装です

## 次の改善候補

- 重複投稿対策
- 失敗イベントの保存と再処理
- `references.md` の月別分割
- PDF OCR対応
- 長文PDFの分割要約
- タグの正規化
- 静的HTML検索ページ
- LINE公式アカウントのプロフィール/一言欄から参照できる公開または限定公開ビュー
- Cloud Runなどへの常時デプロイ
- `check:openai`、`check:line`、`check:drive-write` の追加

## 詳細ログ

構築時に詰まった点、うまくいった点、再発防止策は [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md) に記録しています。
