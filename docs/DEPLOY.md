# デプロイ手順（Cloud Run + Firestore）

常設デプロイの手順。ngrokをやめ、固定URLで常時稼働させる。テナント情報は
**Firestore**に持つ（Cloud Runのファイルシステムは揮発するため）。

設計の背景は [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)、コード規約は
[../CLAUDE.md](../CLAUDE.md) を参照。

## 構成

```
LINE公式アカウント ──▶ Cloud Run（このアプリ, 固定URL, HTTPS自動）
                          │
                          ├─ 各テナントのGoogle Drive（drive.file）
                          └─ Firestore（テナント情報・アーカイブ記録）
```

- **OpenAIとホスティングだけがプロバイダ負担**。資料の実体は各ユーザーのDrive。
- Firestore・Cloud Runとも**無料枠**が大きく、数グループのパイロットなら実質$0。

## 前提（1回だけ）

- GCPプロジェクトを用意し、**Firestore（ネイティブモード）**を有効化。
- **Google Drive API** と **Google Sheets API** を有効化（Sheetsはダッシュボード用。
  無効でも保存は続くが、スプレッドシートは作られない/埋まらない）。
- Cloud Runの実行サービスアカウントに **Firestoreの読み書き権限**（例:
  `roles/datastore.user`）を付与。Cloud Run上では鍵ファイル不要（ADCで認証）。
- Google OAuthクライアント（**Webアプリ型**）。リダイレクトURIは後述の固定URLに合わせる。

## 手順

### 1. デプロイ（ソースから）

```bash
gcloud run deploy line-archive \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --max-instances 1
```

> **`--max-instances 1` は必須（パイロット）。** 現在のストアは単一インスタンス前提
> （メモリキャッシュ＋Firestore書き込み）。複数インスタンスにすると、別インスタンスの
> 接続が再起動まで見えない。スケールするにはストアを非同期read-through化する（CLAUDE.md
> の既知の制限参照）。コールドスタートを避けたい場合は `--min-instances 1` も付ける。

`--source .` を使うと、同梱の `Dockerfile` でビルドされる。

### 2. 環境変数

`.env.example` の値を Cloud Run の環境変数として設定する（秘密値はSecret Manager推奨）。

| 変数 | 値 |
|---|---|
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | LINEのチャネル値 |
| `GOOGLE_OAUTH_CLIENT_JSON` | OAuthクライアントJSON（本体を文字列で渡せる） |
| `PUBLIC_BASE_URL` | デプロイ後に確定するCloud RunのURL（下記4で設定） |
| `TENANT_BACKEND` | `firestore` |
| `GOOGLE_CLOUD_PROJECT` | （任意）プロジェクトid |
| `TENANT_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 要約用 |
| `FREE_MONTHLY_LIMIT` | `50` |

> `PORT` は設定不要。Cloud Runが注入し、`config.ts` がそれを読む。

例：
```bash
gcloud run services update line-archive --region asia-northeast1 \
  --set-env-vars TENANT_BACKEND=firestore,FREE_MONTHLY_LIMIT=50,OPENAI_MODEL=gpt-4.1-mini \
  --set-env-vars TENANT_ENCRYPTION_KEY=<64hex>,PUBLIC_BASE_URL=https://<service-url>
# 秘密値は Secret Manager 経由が望ましい:
#   --set-secrets LINE_CHANNEL_SECRET=line-secret:latest,OPENAI_API_KEY=openai-key:latest,...
```

### 3. 固定URLを確認

```bash
gcloud run services describe line-archive --region asia-northeast1 \
  --format 'value(status.url)'
# 例: https://line-archive-xxxxx.a.run.app
```

### 4. URLを3か所に反映（ここが肝）

この固定URLを、ngrokの時と同じく3か所に登録する。**今回が最後の登録で、以降変わらない。**

1. Cloud Run env の **`PUBLIC_BASE_URL`** = `https://line-archive-xxxxx.a.run.app`
   （設定後、もう一度デプロイ/更新して反映）
2. Google OAuthクライアントの**承認済みリダイレクトURI** =
   `https://line-archive-xxxxx.a.run.app/oauth/callback`
3. LINE Webhook URL = `https://line-archive-xxxxx.a.run.app/line/webhook`

### 5. テストユーザーを登録

Google Cloud Console →「OAuth同意画面」→「テストユーザー」に、使ってもらう人の
Gmailを追加（最大100人）。検証申請なしでも、その人たちは「未確認アプリ」警告を
「詳細→続行」で通過して許可できる。

### 6. 動作確認

`https://<service-url>/healthz` が `{"ok":true}` を返す → グループに公式アカウントを
追加 → 接続リンク → 許可 → PDF/URL投稿で保存、を確認する。

## ローカル開発との違い

- ローカルは `TENANT_BACKEND=json`（`data/tenants.json`）＋ngrokのまま。
- Cloud Runは `TENANT_BACKEND=firestore`。コードは同じ、env切替だけ。
