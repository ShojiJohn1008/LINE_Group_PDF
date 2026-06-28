# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this project is

`line-group-pdf-archive` archives PDFs/files and URLs posted to a LINE group into
Google Drive, and maintains a chronological Markdown index (`references.md`) with
AI-generated Japanese summaries.

Flow: **LINE webhook → download/extract → OpenAI summary → save to Drive → append to `references.md`**.

It is **multi-tenant**: one provider-owned LINE official account is added to many
groups, and each group connects **its own** Google Drive via OAuth (see
`docs/PRODUCT_DESIGN.md`). Events are keyed by `groupId`; per-tenant state lives
in the tenant store. The product framing/target/pricing is in `docs/PRODUCT.md`.

User-facing docs and design notes are written in **Japanese** (`README.md`,
`docs/*.md`). Stored file names, summaries, and `references.md` content are also
Japanese. Keep that convention when touching those artifacts.

## Tech stack

- **Node.js + TypeScript** (ESM, `"type": "module"`), strict mode
- **Express 5** for the webhook server
- **googleapis** (Google Drive v3) for storage
- **openai** (Responses API) for summaries/tags
- **jsdom + @mozilla/readability** for web article extraction
- **pdf-parse** for PDF text extraction
- **tsx** for running/watching TS directly (no build step needed in dev)

## Commands

```bash
npm install          # install deps
npm run dev          # dev server with watch (tsx watch src/server.ts)
npm run build        # compile TS to dist/ (tsc)
npm run start        # run compiled server (node dist/server.js)
npm run typecheck    # tsc --noEmit — the only "test" gate; run before committing
npm run check:drive  # provider-config preflight (OAuth client, redirect URI, store)
npm run google:auth  # legacy single-tenant OAuth token issuer (not used by the flow)
```

There is **no test suite and no linter**. `npm run typecheck` is the verification
gate — always run it after code changes.

## Source layout (`src/`)

| File | Responsibility |
|------|----------------|
| `server.ts` | Express entry point. Routes `/healthz`, `/`, `GET/POST /line/webhook`, and the OAuth web flow `GET /connect` + `GET /oauth/callback`. Verifies LINE signature, ACKs `200`, then handles events async (join/keyword → connect prompt; message → archive). |
| `archive.ts` | Orchestrator. `archiveEvent(event, deps)` looks up the tenant by `groupId`, enforces the monthly quota, then drives extraction → summary → Drive upload → index append. Owns file-naming and label cleanup. |
| `oauth.ts` | OAuth state sign/verify (HMAC), Google auth-URL build, code→refresh-token exchange, and `authedClient()` (OAuth2 client primed with a tenant refresh token). |
| `store.ts` | Tenant store: `groupId → { refreshToken(encrypted), rootFolderId, indexFileId, usage }`. JSON-file backend for the pilot, behind a `TenantStore` interface. AES-256-GCM at rest. Monthly usage counter (JST). |
| `line.ts` | Inbound: LINE HMAC-SHA256 signature verification + message content download. |
| `line-push.ts` | Outbound: bot reply/push (connect link, completion + quota notices). |
| `drive.ts` | Per-tenant Google Drive client (built from a refresh token), `drive.file` scope, `provisionArchive()` (create/own root folder + `references.md`), folder ensure/create, buffer upload, index append. |
| `summary.ts` | OpenAI summarization → `{ bullets, tags }`. Degrades gracefully (never throws) when key missing or API fails. |
| `web.ts` | Fetch URL, extract readable text + build Markdown snapshot, plus `extractUrls()` regex. |
| `pdf.ts` | PDF → normalized text. |
| `time.ts` | Shared Japan-timezone helpers (`getJapanDateParts`, `formatYearMonth`, `formatDateForFile`). |
| `config.ts` | Loads/validates provider-global env into `AppConfig`; exports `GOOGLE_DRIVE_SCOPE`, `redirectUri()`. |
| `types.ts` | Shared types: `LineWebhookEvent`, `LineMessage`, `ArchiveEntry`. |
| `check-drive.ts` | Provider-side config preflight (OAuth client, redirect URI, store writability). |
| `google-auth.ts` | Legacy standalone single-tenant OAuth token issuer. Not part of the multi-tenant flow; kept for manual testing. |

## Key conventions and invariants

- **ESM imports use `.js` extensions** even for TS source (e.g.
  `import { loadConfig } from "./config.js"`). NodeNext resolution requires this —
  do not drop the extension or use `.ts`.
- **Always `dotenv.config({ override: true })`** at the top of entry points
  (`server.ts`, `check-drive.ts`, `google-auth.ts`). `override: true` is
  deliberate: a stale env var in the parent shell must not win over `.env`.
- **Dates/folders/usage windows use Japan time (`Asia/Tokyo`)** via
  `Intl.DateTimeFormat`. Use the `time.ts` helpers (`getJapanDateParts` /
  `formatYearMonth` / `formatDateForFile`); do not reintroduce UTC
  `getMonth()`-style code.
- **Multi-tenancy is keyed by `groupId`.** One LINE webhook receives every
  group's events; `archiveEvent` demuxes by `source.groupId || source.roomId`,
  loads the tenant, and uses that tenant's Drive client. No tenant → don't
  archive (the webhook handler prompts to connect on `join` / the "接続" keyword).
- **Drive scope is `drive.file`** (`GOOGLE_DRIVE_SCOPE` in `config.ts`) — the app
  only ever sees files it created. The archive root folder is **created and owned
  by the app** in the user's Drive (`provisionArchive`); there is no
  user-supplied folder ID. Do not widen to full `drive` (triggers Google's
  restricted-scope CASA review and touches the user's other files).
- **Drive layout is fixed (inside the app-owned root folder of each tenant's Drive):**
  ```
  LINE資料アーカイブ/
    references.md
    files/YYYY-MM/YYYY-MM-DD_PDF_<label>.pdf
    files/YYYY-MM/YYYY-MM-DD_FILE_<label>.<ext>
    web/YYYY-MM/YYYY-MM-DD_URL_<label>.md
  ```
  Stored file name = `YYYY-MM-DD_<KIND>_<contentLabel>.<ext>`. The content label
  prefers the first usable summary bullet, falling back to the original
  title/filename (`bestContentLabel` → `cleanupLabel` → `sanitizeFileName`).
- **`references.md` must be a real `text/markdown` file**, never a Google Docs
  file. `getOrCreateIndexFile` explicitly skips `application/vnd.google-apps.*`
  files; its id is stored per tenant in the store. Appends are read-modify-write
  (download full text, append entry, re-upload).
- **Per-tenant secrets:** only the Google refresh token is per-tenant, and it is
  **encrypted at rest** (AES-256-GCM, `TENANT_ENCRYPTION_KEY`). LINE / OpenAI /
  OAuth-client secrets are provider-global. Never store refresh tokens in
  plaintext or log them.
- **Free tier:** `FREE_MONTHLY_LIMIT` (default 50) summaries/saves per tenant per
  JST month, enforced in `archive.ts` (`withinQuota`); the group is notified once
  when it crosses the limit. The metered cost is OpenAI, not storage (files live
  in the user's Drive).
- **All Drive calls pass `supportsAllDrives: true`** (and list calls
  `includeItemsFromAllDrives: true`). Keep this for shared-drive compatibility.
- **Resilience by design:** the webhook ACKs `200` before processing; per-event
  failures are caught and logged, not propagated. Summarization and PDF
  extraction failures degrade to placeholder text but still archive the file.
  Preserve this "never lose the artifact" behavior.
- **Secrets must never be logged.** API keys are redacted via the
  `redactApiKey` (`sk-***`) helpers in `server.ts` and `summary.ts`. Do not log
  raw error objects from googleapis/openai; use the existing short-diagnostic
  formatters.

## Authentication

- **Provider Google OAuth app (one, shared)** — `GOOGLE_OAUTH_CLIENT_JSON` must be
  a **Web application** client with `<PUBLIC_BASE_URL>/oauth/callback` registered
  as an authorized redirect URI. Each tenant connects by clicking "Allow" on
  Google's consent screen (`/connect` → Google → `/oauth/callback`); the resulting
  refresh token is stored encrypted. Users never touch Google Cloud Console.
- **Per-tenant Drive** — files land in each group's own Drive via that group's
  refresh token (`authedClient` → `createDriveClient`). The provider pays no
  storage; data ownership stays with the user (decision recorded in
  `docs/PRODUCT_DESIGN.md`).

LINE webhook requests are authenticated by HMAC signature
(`x-line-signature`) using `LINE_CHANNEL_SECRET`.

## Configuration (`.env`)

See `.env.example`. Required: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`,
`GOOGLE_OAUTH_CLIENT_JSON`, `PUBLIC_BASE_URL`, `TENANT_ENCRYPTION_KEY`
(`openssl rand -hex 32`). Optional: `OPENAI_API_KEY`, `OPENAI_MODEL` (default
`gpt-4.1-mini`), `TENANT_STORE_PATH` (default `data/tenants.json`),
`OAUTH_STATE_SECRET` (defaults to the LINE secret), `FREE_MONTHLY_LIMIT`
(default `50`), `PORT` (default `3000`).

`npm run check:drive` validates this provider config before deploy. After
editing `.env`, **restart `npm run dev`** — it does not hot-reload env.

## Git hygiene

`.env`, `secrets/`, `data/` (tenant store), `node_modules/`, `dist/`, `tmp/` are
gitignored. **Never commit secrets**, OAuth tokens, the tenant store, or
service-account JSON, and never paste secret values into code, docs, commit
messages, or chat.

## Webhook setup note

LINE Developers Webhook URL must include the full path `/line/webhook`
(e.g. `https://<public-url>/line/webhook`), not just the host — a common
source of 404s. `ngrok http 3000` is used to expose the local server.

## Known limitations (don't assume these are bugs)

- No de-duplication of repeated URLs/events.
- No OCR for scanned PDFs; long PDFs are summarized from the leading text only
  (clipped to 24k chars in `summary.ts`).
- Message-unsend (revoke) events are not handled.
- History before the bot joined the group is unreachable.
- The tenant store is a **single-instance JSON file** (pilot). Scaling to
  multiple server instances needs a real DB (SQLite/Postgres) behind the same
  `TenantStore` interface.
- The Google OAuth app is unverified until submitted: capped at 100 users and
  shows an "unverified app" screen. Fine for the pilot; verify before public
  launch (see `docs/PRODUCT_DESIGN.md`).
