# プロダクト設計 — マルチテナント化とオンボーディング

[PRODUCT.md](PRODUCT.md) の「プロダクト化に足りないもの」を実装に落とす設計。
現状のMVP（`.env` 1セット ＝ 1グループ ＝ 1Drive）から、**1つのLINE公式
アカウントを多数のグループが追加し、各グループが自分のGoogle Driveを接続する**
マルチテナント構成へ移行する。

## 決定事項：保存先はユーザー自身のDrive（Option A）

各テナントは**自分のGoogle Driveを接続**し、資料はそのDriveに保存する。
プロバイダのストレージに全情報をためる方式（Option B）は採らない。理由：

- ユーザーは保存された資料を**普段のDriveとして自由に閲覧・整理・共有**できる。
- 解約してもデータはユーザーの手元に残る。
- プロバイダは**全顧客データを抱える保管責任とストレージ代を負わない**。

この決定の帰結として、接続時に各ユーザーの「許可」クリックが1回必要になる
（その代わりCloud Consoleは不要）。以降の設計はすべてこの前提で書く。

## 0. 目標とするユーザー体験

フロント側（病院の先生＝管理者）の操作はこれだけ：

1. LINE公式アカウントを**友だち追加**し、**グループに招待**する。
2. Botがチャットに出す**接続リンクをタップ**する。
3. Googleの「許可」画面で**「許可」を1回押す**。

これで完了。**Google Cloud Console は一切触らない。** 触るのは設定する側
（プロバイダ）だけ。ユーザーが見るのは「Googleでログイン」と同じ標準の同意
画面だけ。

## 1. 鍵となる設計判断

### (a) Google OAuthアプリはプロバイダが1個だけ持つ

- Cloud ConsoleでOAuthクライアント（client_id / client_secret）を**1回だけ**
  作るのはプロバイダ。これは全テナント共通。
- 各ユーザーは、そのアプリの**同意画面で「許可」を押すだけ**。これにより
  ユーザーごとの **refresh token** が発行され、プロバイダがそれを保管する。
- ユーザー側の操作は「リンクをタップ → 許可」。Cloud Console もAPIキー発行も
  不要。「APIはこちらで管理」が成立する。

### (b) スコープは `drive` ではなく `drive.file` にする

現状コードは全権の `drive` スコープ＋既存フォルダID（`GOOGLE_DRIVE_FOLDER_ID`）
を使うが、プロダクトでは **`drive.file`（アプリが作ったファイルだけ）** に変える。

- アプリは接続時に各ユーザーのDrive内に **「LINE資料アーカイブ」フォルダと
  `references.md` を自分で作る**。以降はそれだけを読み書きする。ユーザーの他の
  ファイルには一切アクセスしない。
- 利点1：**フォルダIDのコピペが不要**になる（オンボーディングがさらに簡単）。
- 利点2：`drive` は Google の「制限付きスコープ」で年次のセキュリティ審査
  （CASA）が要るが、`drive.file` は対象外。**審査負荷が大幅に下がる。**
- 利点3：ユーザーに「あなたのDriveを全部見るアプリ」と思わせない。信頼面で有利。

### (c) ファイルの実体はユーザーのDrive、メータ対象はOpenAIだけ

- 保存先は**各ユーザーのDrive**（その人のrefresh tokenで書く）。プロバイダは
  ストレージ代を負担しない。ユーザーは解約してもデータが手元に残る。
- プロバイダが負担するのは **OpenAI要約 ＋ ホスティング**。だから
  [PRODUCT.md](PRODUCT.md) の「月50件まで無料」は、**要約件数 = 課金対象**として
  数えるのが筋。ストレージではなく要約がメータ。

## 2. オンボーディング・フロー（具体）

```
1. 管理者: 公式アカウントをグループに追加
2. Bot:   join イベント受信（groupId が取れる）
          → グループに接続リンクを投稿
            https://app.example.com/connect?state=<署名付きトークン>
            （state に groupId + nonce + 有効期限を埋める）
3. 管理者: リンクをタップ（ブラウザが開く）
4. Server: state を検証 → Googleの同意画面へリダイレクト
            （プロバイダのOAuthアプリ / drive.file スコープ）
5. 管理者: 「許可」を押す（Googleとの接点はここだけ）
6. Google: /oauth/callback?code=...&state=... にリダイレクト
7. Server: code → refresh token に交換
            ユーザーDriveに「LINE資料アーカイブ」+ references.md を作成
            tenant store に保存: groupId → {refresh_token(暗号化),
                                            folderId, indexFileId}
8. Bot:   グループに「接続が完了しました」を push
9. 以降:  その groupId のメッセージは、そのユーザーのDriveへ自動保存
```

リンク投稿が `join` で出しづらい場合のフォールバック：管理者がグループで
「接続」とだけ送る → Botがリンクを返信。これが「URLをコピーしてチャットに
送る」操作に対応する。

## 3. マルチテナント・アーキテクチャ

```
            ┌─────────────────────────────────────────┐
   LINE ───▶│ Webhook ingest (server.ts)              │
 (1公式AC)  │  署名検証 → 200即ACK → groupIdで振り分け │
            └──────────────┬──────────────────────────┘
                           │ groupId
                           ▼
            ┌─────────────────────────────────────────┐
            │ Tenant store (DB)                       │
            │  groupId → {refresh_token(暗号化),       │
            │            folderId, indexFileId,        │
            │            plan, usage(月次)}            │
            └──────────────┬──────────────────────────┘
                           │ 接続済みなら
                           ▼
            ┌─────────────────────────────────────────┐
            │ archiveEvent: そのテナントのDrive clientで│
            │  抽出 → 要約 → 保存 → references.md追記   │
            │  （要約前に usage < 50 を確認）          │
            └─────────────────────────────────────────┘

  別系統: /connect, /oauth/callback (OAuth web flow)
          line-push (Botからグループへ返信・通知)
```

ポイント：
- **1公式アカウント ＝ 1 Messaging APIチャネル ＝ 1 webhook**。全グループの
  イベントが同じwebhookに来るので、`source.groupId` で振り分ける（現状の
  イベント型に groupId は既にある）。
- **テナントごとに持つ秘密は Google refresh token だけ**。LINE/OpenAI/OAuth
  クライアントの鍵はプロバイダ共通。

## 4. 既存コードへの変更マップ

| ファイル | 変更内容 |
|---|---|
| `config.ts` | プロバイダ共通設定（LINE鍵・OpenAI鍵・OAuthクライアント・暗号鍵・DB接続）と、テナント別ランタイム（storeから取得）に分離。テナント別の `GOOGLE_DRIVE_FOLDER_ID` 等は廃止。 |
| `drive.ts` | `createDriveClient` をファイルのトークンではなく**storeのrefresh tokenを受け取る**形に。スコープを `drive.file` に。フォルダは毎回**自分で作って所有**（外部フォルダID不要）。 |
| `archive.ts` | `archiveEvent` が groupId でテナントを引く → そのDrive clientを使う → 要約前に**使用量チェック**。 |
| `server.ts` | `/connect`・`/oauth/callback` 追加。`join`/`follow` イベント処理。LINE **push API** でグループへ返信（現状は送信機能なし）。 |
| 新 `tenants.ts` | テナントstore（pilotはSQLite → スケールでPostgres）。refresh token暗号化。 |
| 新 `oauth.ts` | web OAuthフロー＋state署名（JWT等）。 |
| 新 `usage.ts` | 月次の要約/保存件数カウントと50件上限の判定。 |
| 新 `line-push.ts` | Botからグループへメッセージ送信（接続リンク・完了通知・上限通知）。 |
| 新規依存 | DBクライアント、暗号化（refresh token保管）、署名トークン。 |

## 5. 誰が何を管理するか

| | プロバイダ（あなた） | テナント（先生） |
|---|---|---|
| Google Cloud Console | OAuthアプリを1回作る | **触らない** |
| LINE | 公式アカウント・Messaging APIチャネル・webhook | 友だち追加・グループ招待のみ |
| OpenAI | APIキー・課金 | なし |
| Google同意 | — | 「許可」を1回押す |
| ストレージ | 負担しない | **自分のDrive** |
| 保管する秘密 | LINE/OpenAI/OAuthクライアント鍵、全テナントのrefresh token（暗号化） | なし |

## 6. 正直なリスクと前提

- **Google OAuthアプリの検証** — `drive.file` でも、外部ユーザーに使わせるには
  ブランド/アプリ検証が要る。未検証アプリは **100ユーザー上限＋「未検証」警告**
  が出る。最初の総合診療科パイロットは100人枠で**即動く**が、一般公開前に検証
  申請が必要。`drive.file` を選ぶ理由はこの審査を軽くするため（制限付きスコープの
  CASAを避ける）。
- **LINE公式アカウントのグループメッセージ受信** — グループ内メッセージ・
  イベントを受け取れるよう、LINE側で設定が要る（プロバイダ側の1回設定）。
  LINEはグループ機能の制限を変えることがあるので、`join` とメッセージ受信が
  実際に来るか要確認。
- **refresh token の保管はセキュリティ面** — 多数ユーザーのDrive refresh token
  を持つ ＝ 価値の高い秘密の集合。**保存時暗号化・失効処理・最小スコープ
  （drive.file）** が前提。MVPには無かった責任が増える。
- **データ所有** — 実体もreferences.mdもユーザーのDriveにある（解約してもデータが
  残る＝信頼に有利、プロバイダの保管責任は軽い）。

## 7. 段階

1. **パイロット**：総合診療科グループ1つ。未検証アプリ（100人枠）で接続フローと
   「Dropbox二重投稿が消える」を実証。tenant storeはSQLiteで十分。
2. **検証申請**：`drive.file` でGoogleのアプリ検証を出す。常設デプロイ
   （Cloud Run等）へ移行しngrok依存を外す。
3. **スケール**：Postgres化、使用量課金（月50件）、上限通知、複数グループ/病院。
