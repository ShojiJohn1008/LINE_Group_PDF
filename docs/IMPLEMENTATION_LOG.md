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

## 2026-06-28 マルチテナント化とパイロット接続

単一テナントMVP（`.env` 1セット ＝ 1グループ ＝ 1Drive）から、**1つのLINE公式
アカウントを多数のグループが追加し、各グループが自分のDriveを接続する**
マルチテナント構成へ移行した。

### プロダクト整理

- ターゲットを1グループに固定：**私立総合病院・総合診療科のLINEグループ**。
  現状はT先生がLINEとDropboxへ**二重投稿**して資料を在庫化している。その手作業を
  「LINEに貼る＝在庫化」で消すのが第1のペイン。詳細は `docs/PRODUCT.md`。
- 課金は **月50件まで無料、超過で有料**（メータ対象はストレージではなくOpenAI要約）。
- 保存先は **各ユーザー自身のDrive（Option A）** に決定。提供側は全データを抱えず、
  ユーザーは自分の情報を自由に扱える。設計は `docs/PRODUCT_DESIGN.md`。

### 実装したもの

- **プロバイダが Google OAuth アプリを1個だけ持つ。** ユーザーはCloud Console不要、
  同意画面で「許可」1回。スコープは `drive.file`（制限付きスコープのCASA審査を回避、
  アプリが作ったファイルだけ）。フォルダはアプリが各Driveに自前作成・所有。
- **テナントストア `store.ts`**：`groupId → {refresh_token（AES-256-GCM暗号化）,
  rootFolderId, indexFileId, 月次usage}`。パイロットはJSONファイル、`TenantStore`
  インターフェースの裏（後でSQLite/Postgresに差し替え可能）。
- **接続フロー**：`/connect`（state署名検証→Google同意へ）+ `/oauth/callback`
  （code交換→Drive provision→テナント保存→グループへ完了通知）。state はHMAC署名で
  groupId をブラウザ往復させる。
- **イベント処理**：webhookを `groupId` で振り分け。follow（友だち追加）→使い方紹介、
  join（グループ追加）→紹介＋接続リンク、`/接続` コマンド→リンク、message→アーカイブ。
- **無料枠**：`FREE_MONTHLY_LIMIT`（既定50）をJST月で `archive.ts` の `withinQuota` が
  判定。超過時はグループに1回だけ通知。
- 新規：`oauth.ts` / `store.ts` / `line-push.ts`（Bot送信）/ `time.ts`（JST共通化）。

### パイロット実機テストで詰まった点と対処

- **`tsx: command not found`** … cloned直後で依存未インストール。`npm install`。
- **`Missing required environment variable: LINE_CHANNEL_SECRET`** … `.env` の値が空。
  `requireEnv` は空文字も未設定扱い。実値を投入して解決。
- **`403: disallowed_useragent`**（Googleログイン時）… LINE内蔵ブラウザ（webview）での
  OAuthをGoogleが拒否。接続リンクに **`openExternalBrowser=1`** を付け、外部ブラウザで
  開かせて解決（`oauth.ts` の `buildConnectUrl`）。
- **ローカルに変更が来ない** … 修正はリモートブランチにpush済みでも、ローカル実行には
  `git pull` が必要。

### トリガーの改善

接続トリガーを「文中に『接続』を含む」→「**`/` で始まるコマンドと完全一致**
（`/接続`・`/connect`・`/せつぞく`）」に変更。会話文中の「接続」で誤反応しなくなった。
案内は日本語の `/接続` を主に見せ、`/connect` も裏で有効（グローバル対応）。

### 残課題（次回以降）

- Google OAuthアプリの**検証申請**（未検証は100ユーザー上限＋警告）。
- ngrok依存をやめて**常設デプロイ**（Cloud Run等）。ngrok静的ドメインで当面しのぐ。
- 接続済みグループの**再接続コマンド**（今は未接続グループのみ `/接続` を受付）。
- テナントストアの**DB化**（複数インスタンス対応）。
- 重複投稿・送信取消の対応。

## 2026-06-28（続き）常設デプロイ・再接続/重複/取消・ダッシュボード

前項の残課題をまとめて実装し、Cloud Runへ常設デプロイ完了。

### 機能追加

- **再接続コマンド**：`/接続` を接続済みグループでも受け付け、別のDriveに繋ぎ直せる
  ようにした（再OAuthで上書き）。
- **重複防止**：テナントごとに、同じURL（`#`以降を除去）／同じファイル
  （`ファイル名:サイズ`）を二重保存しない。`store.isArchived`/`recordArchive`。
- **送信取消（非破壊）**：LINEの `unsend` を受信→そのメッセージ由来の保存物を
  `references.md` で「（送信取消済み）」と注記。Driveの実ファイルは残す。Drive file id
  は隠しコメント `<!-- id:X -->` で持ち、注記の突き合わせに使う。
- **references.md の刷新（見やすさB）**：1資料1カード（種別アイコン＋日付・タグ・
  リンクを1行＋要約）。ノイズ項目を非表示化。
- **Google スプレッドシート ダッシュボード（A）**：保存フォルダ内に
  「資料ダッシュボード」を作成し、1資料1行で追記（日付/種別/タイトル/タグ/要約/
  保存先/元URL）。Sheetsの並べ替え・フィルタ・検索がそのまま使える。`drive.file`
  のままでアプリ作成シートとして扱える。すべてbest-effort（Sheets API未有効でも保存は継続）。

### インフラ

- **Cloud Run + Firestore**。ストアを共通エンジン（`createMemoryStore`）＋バックエンド
  差し替え（JSON / Firestore）にリファクタ。env `TENANT_BACKEND` で切替。
- `Dockerfile`（マルチステージ）、`docs/DEPLOY.md`（手順・env・URL3か所登録・
  テストユーザー登録・**Sheets API有効化**）。
- **Firestoreバックエンドは単一インスタンス前提**（起動時キャッシュ＋書き込み）。
  Cloud Runは `--max-instances 1` で運用。複数インスタンス化には非同期read-through
  ストアが必要。

### 詰まった点

- Cloud Runのデプロイ自体。Sheets APIを有効化したらダッシュボードも表示された。

### 残課題

- Google OAuthアプリの検証申請（一般公開・100人超の前）。
- ストアの非同期read-through化（複数インスタンスへスケールする場合）。
- 「完全削除」版の送信取消（現状は注記のみ）。
- ホスト型Webダッシュボード（公開/限定ビュー）。

## 2026-07-01 Cloud Run本番接続・Firestore運用修正・無料枠UX

Cloud Run常設環境を実際に立ち上げ、Google OAuth/LINE Webhook/Drive保存までを通した。
あわせて、実運用で見えたFirestore database ID、Drive上の `references.md`、Web
ダッシュボード、無料枠通知の問題を修正した。

### GCP/Cloud Run設定

- `gcloud` を導入し、プロジェクト `line-group-pdf` をCLIから操作できるようにした。
- Cloud Run / Cloud Build / Artifact Registry / Firestore / Drive API / Sheets API /
  Secret Manager を有効化。課金アカウント未リンクでAPI有効化に失敗したため、Billingを
  紐づけて再実行。
- Cloud Run実行サービスアカウント `line-archive-runner` を使用。
  `roles/datastore.user` と Secret Managerアクセス権を付与。Cloud Run上では鍵ファイル
  なしでADCを使う。
- Secret ManagerにOAuthクライアントJSON、LINE secret/token、OpenAI API key、
  `TENANT_ENCRYPTION_KEY` を保存し、Cloud Runから参照。
- Cloud Run URLは以下で確定。OAuth redirect URIとLINE Webhook URLもこのURLに統一。

```text
PUBLIC_BASE_URL=https://line-archive-aq44p5jz2q-an.a.run.app
OAuth redirect URI=https://line-archive-aq44p5jz2q-an.a.run.app/oauth/callback
LINE Webhook URL=https://line-archive-aq44p5jz2q-an.a.run.app/line/webhook
```

### Firestore database ID問題

FirestoreはNative mode / Standard Editionで作成したが、database IDを `(default)` ではなく
`line-group-pdf` にした。`@google-cloud/firestore` はデフォルトでは `(default)` を見に行く
ため、Cloud Run起動時に `5 NOT_FOUND` で落ちた。

再発防止として以下を実装。

- `FIRESTORE_DATABASE_ID` 環境変数を追加。
- `createFirestoreTenantStore` で `{ projectId, databaseId }` を指定可能にした。
- Cloud Runに `FIRESTORE_DATABASE_ID=line-group-pdf` を設定。
- `docs/DEPLOY.md` に、database IDが `(default)` 以外の場合は必須と追記。

### `references.md` が見えない問題

接続後、Drive上にフォルダと `files/` はできるが `references.md` が見えない状態になった。
Firestoreには `indexFileId` が保存されており、Drive APIで確認すると `references.md` は
存在するが `trashed: true`、つまりゴミ箱に入っていた。

対応:

- 対象の `references.md` をDrive APIで復元。
- 保存済み `indexFileId` のファイルがゴミ箱入りなら、`getOrCreateIndexFile` で復元してから
  使うようにした。
- ファイルが見つからない場合は `indexFileId` を捨て、通常の検索/作成フローへ戻す。

### Webダッシュボードの500

再接続後に `/view/:token` を開くと `Internal Server Error` になった。ログでは
`RangeError: Invalid time value`。原因は、古い `archived` レコードには `postedAt` が無く、
Webダッシュボードが `new Date(item.postedAt)` を日付整形しようとして落ちたこと。

対応:

- `postedAt` が無い既存データでは `createdAt` をフォールバックに使う。
- それでも不正な日付なら空文字にし、ダッシュボード全体は落とさない。

### 無料枠UX

`FREE_MONTHLY_LIMIT=2` で検証。Cloud Runの環境変数を更新しない限り、ローカル `.env` の変更は
Cloud Runへ自動反映されないことを確認した。

当初の実装は、月次使用数が上限に達した最初の1件だけ通知し、それ以降は無言で保存しない
仕様だった。LINE上では「処理されたのか、無視されたのか」が分かりにくいため、上限超過時は
毎回メッセージを返すように変更した。

現在の判定:

```text
usageCount < FREE_MONTHLY_LIMIT
  → 保存する

usageCount >= FREE_MONTHLY_LIMIT
  → 保存しない
  → 毎回LINEに超過メッセージを返す
```

### デプロイ/検証

- Cloud Runへ複数回デプロイし、最新リビジョンで `/healthz/` と `/line/webhook` の疎通を確認。
- Webダッシュボード `/view/:token` が200で開くことを確認。
- 新規レコードでは `driveUrl` がFirestoreに保存され、ダッシュボードからDriveファイルへ移動
  できることを確認。
- `npm run typecheck` / `npm run build` は通過。

### 残メモ

- Cloud Runの `--set-env-vars` は通常環境変数の扱いに注意。更新時は既存の通常envをまとめて
  指定する運用にする。
- `/healthz` は環境によりGoogle Frontend側404になったため、疎通確認は末尾スラッシュ付きの
  `/healthz/` を使う。
- 古い `archived` レコードには `postedAt` / `driveUrl` / `summary` / `tags` が欠けるものがある。
  新規保存分からは揃う。必要なら後でFirestoreの既存データ補完を行う。

## 2026-07-01 Webダッシュボード・競合修正・体感速度・Cloud Runランタイム調整

### Webダッシュボード（案C）

- **限定リンク方式**で読み取り専用のWeb画面 `GET /view/:token` を追加（`view.ts`）。
  グループごとの推測不能な `viewToken`（再接続でも安定）でアクセス制御。
- UIは自己完結HTML（検索・種別/タグフィルタ・カード）。内容はJSON埋め込み→JSの
  `textContent` で描画（XSS安全）、リンクは `http(s)` のみ許可。悪意入力4種で検証。
- データ源は自前ストア。`ArchivedItem` に表示用フィールド（日付/タグ/要約/リンク）を
  追加し、閲覧時にユーザーのDriveを触らない。導線は接続完了メッセージ＋「/一覧」コマンド。

### 競合バグ修正（重要）

- `server.ts` がイベントを待たずに並行起動し、`appendToIndex` が read-modify-write
  だったため、**同一グループの同時投稿で references.md の追記が片方消える**恐れ。
  → `queue.ts`（グループ単位の直列化キュー）を全イベントに適用して解消。抄読会後の
  連投がまさに踏む導線だった。

### 体感速度（先に保存→あとで要約）

- ファイルを**仮名でDriveに即アップロード**→OpenAI要約を並行実行→要約後にリネームし
  索引・シート・ダッシュボードを更新。Driveへの反映から要約待ちを外した。
- `files`/`web`/月フォルダのIDを**キャッシュ**（Drive往復2〜4回を削減、失敗時1回再解決）。

### Cloud Runランタイム調整（詰まった点と対処）

- **反映が90秒〜3分と激遅**。原因は **Cloud RunのCPUスロットリング**：webhookに即200を
  返した後の**バックグラウンド処理中はCPUがほぼ止まる**（デフォルトはリクエスト処理中
  のみCPU割当）。「先に保存」の効果も打ち消されていた。
  → **`--no-cpu-throttling`（CPU常時割当）** で解決。数分→数十秒に短縮。
- **コールドスタート**は `--min-instances 1` で消せるが、常時1台起動＝固定費（1 vCPU
  24時間で概算 月$40〜60）。パイロットは投稿が散発的なので **`--min-instances 0` に戻す**
  判断（普段は課金ほぼ0、1発目だけ数秒待ち、起きていればCPU常時割当で速いまま）。
- **無料枠超過**：テスト投稿で `FREE_MONTHLY_LIMIT`（50）に到達し保存停止。env更新
  （`--update-env-vars FREE_MONTHLY_LIMIT=...`）で対応。envのみ変更は再デプロイ不要
  （自動で新リビジョン）。カウンタはJST月初に自動リセット。
- 実機デバッグ由来の修正（別途取り込み済み）：Firestoreの名前付きDB対応
  （`FIRESTORE_DATABASE_ID`）、ゴミ箱に入った index の復元、quota通知の文言改善。

### 現在の運用構成（まとめ）

- Cloud Run（`asia-northeast1` / サービス `line-archive`）＋ Firestore。
- `--no-cpu-throttling` 有効、`--min-instances 0`、`--max-instances 1`。
- ビュー3種：`references.md`（カード）／資料ダッシュボード（Sheet）／Web（/view/:token）。

### 残課題

- Google OAuthアプリの検証申請（一般公開・100人超の前）。
- ストアの非同期read-through化（複数インスタンス化・`--max-instances 1` を外す前提）。
- 医療資料向けの要約設計（論文の研究デザイン/N/主要アウトカム/限界の構造化、タグ正規化）。
- バースト投稿時のキュー詰まり（1件あたりは速いが直列なので大量連投で待ちは増える）。
- 閲覧トークンの失効/再発行コマンド。
