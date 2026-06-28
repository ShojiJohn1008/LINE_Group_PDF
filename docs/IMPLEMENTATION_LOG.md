# 実装ログと再発防止メモ

このメモは、LINEグループ資料アーカイブMVPを構築したときの判断、詰まった点、再発防止策を残すための記録です。APIキー、OAuthトークン、サービスアカウントJSONなどの秘密値は記録しません。

## 目的

LINEグループに投稿されたPDFやURLは、LINE上では時間経過で参照しづらくなる。普段の投稿行動は変えず、Botが投稿を拾ってGoogle Driveに保存し、後から見返せるMarkdown索引を作る。

## MVPの到達点

- LINE Official Account Botをグループに追加できた
- LINE Messaging API Webhookを受信できた
- URL投稿を検出できた
- Web本文を抽出し、Google DriveへMarkdownとして保存できた
- OpenAI APIで要約を生成できた
- Google Drive上の `references.md` に要約つきで追記できた
- 保存先を `web/YYYY-MM/`、`files/YYYY-MM/` に月別分割できた
- ファイル名を `YYYY-MM-DD_種別_内容ラベル` 形式へ改善できた

## 現在の保存規則

```text
LINE資料アーカイブ/
  references.md
  files/
    YYYY-MM/
      YYYY-MM-DD_PDF_内容ラベル.pdf
      YYYY-MM-DD_FILE_内容ラベル.ext
  web/
    YYYY-MM/
      YYYY-MM-DD_URL_内容ラベル.md
```

`内容ラベル` は要約の先頭要点を優先する。要約が作れない場合は、元タイトルまたは元ファイル名を使う。日付と月は日本時間で決める。

## うまくいった設計

### LINE側

LINEグループのユーザー行動を変えず、Botを追加するだけの設計にしたのは正解だった。資料を別サービスに手動アップロードさせるより、既存の投稿動線に沿っている。

### 保存形式

Google Driveに実体を保存し、`references.md` を索引にする構成は扱いやすかった。DriveはPDFやMarkdownスナップショットの置き場所として自然で、MarkdownはGitや静的HTML化に展開しやすい。

### OAuth方式

個人用Google Driveでは、サービスアカウントではなくOAuth方式が適していた。サービスアカウント方式は一見Botらしいが、通常のマイドライブでは保存容量制約に当たった。

### 診断コマンド

`npm run check:drive` を追加したことで、LINE、OpenAI、Driveのどこで詰まっているかを切り分けやすくなった。

## 詰まった点と原因

### Webhook URLが404

ngrokのURLだけをLINE Developersに貼ると404になった。正しくは `/line/webhook` まで含める必要がある。

```text
https://<ngrok-url>/line/webhook
```

再発防止として、`GET /line/webhook` と `/healthz` に診断レスポンスを追加した。

### Google Drive APIが未有効

Drive APIを有効化していない状態で `check:drive` を実行すると403になった。Google Cloud ConsoleでGoogle Drive APIを有効化する必要がある。

### サービスアカウントの保存容量制約

サービスアカウントで個人用マイドライブに新規ファイルを作ろうとして、以下の制約に当たった。

```text
Service Accounts do not have storage quota
```

個人DriveではOAuth方式へ切り替える。Google Workspaceの共有ドライブならサービスアカウント方式も候補になる。

### OAuth redirect_uri_mismatch

Webアプリ型OAuthクライアントを使ったため、リダイレクトURI設定で詰まった。今回のローカルアプリでは、デスクトップアプリ型OAuthクライアントを作る方が簡単。

### OAuth access_denied

OAuth同意画面がテスト中で、ログインするGoogleアカウントがテストユーザーに入っていなかった。テストユーザーへ追加すると認可できた。

### OpenAI API keyが古い値で読まれた

`.env` には新しいキーが入っていたが、親シェルに古い `OPENAI_API_KEY` が残っており、dotenvのデフォルト動作では親シェルの値が優先された。

再発防止として、起動時に `dotenv.config({ override: true })` を使い、`.env` を優先するようにした。

### references.mdが複数作成された

修正前のDrive作成処理で、`references.md` がGoogle Docs形式として作られてしまった。Google Docs形式は `alt=media` で本文取得できず、更新に失敗した。

再発防止:

- Google Workspace形式ではない `text/markdown` の `references.md` を優先する
- 正しいファイルIDを `GOOGLE_DRIVE_INDEX_FILE_ID` に固定する
- Google Docsアイコンの古い `references.md` は削除してよい

### Google APIのエラーが長すぎる

`GaxiosError` が内部情報を大量に表示して見づらかった。`check:drive` とWebhookログでは、原因が分かる短い診断に寄せた。

## 現在の注意点

- `.env`、`secrets/`、`node_modules/`、`dist/` はGitに入れない
- `GOOGLE_DRIVE_INDEX_FILE_ID` は、正しい `text/markdown` の `references.md` を指す
- `npm run dev` 起動後に `.env` を変えた場合は再起動が必要
- ngrok無料URLは変わるため、LINE DevelopersのWebhook URLも更新が必要
- OpenAI要約に失敗しても保存自体は続ける設計にしている

## 次の改善候補

### 優先度高

- 重複投稿対策
- 失敗イベントの保存と再処理
- `references.md` の月別分割
- 常設デプロイでngrok依存をなくす

### PDF対応

- スキャンPDF OCR
- 長文PDFの分割要約
- PDF本文タイトル抽出によるファイル名改善

### UX

- 静的HTML検索ページ
- LINE公式アカウントのプロフィール/一言欄から参照できるリンク設置
- タグ正規化
- 日付、種別、タグでのフィルタ

### 運用

- `check:openai`
- `check:line`
- `check:drive-write`
- 失敗ログのDrive保存
- 本番用Secret管理
