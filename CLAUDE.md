# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this project is

`line-group-pdf-archive` is an MVP that archives PDFs/files and URLs posted to a
LINE group into Google Drive, and maintains a chronological Markdown index
(`references.md`) with AI-generated Japanese summaries.

Flow: **LINE webhook → download/extract → OpenAI summary → save to Drive → append to `references.md`**.

User-facing docs and design notes are written in **Japanese** (`README.md`,
`docs/IMPLEMENTATION_LOG.md`). Stored file names, summaries, and `references.md`
content are also Japanese. Keep that convention when touching those artifacts.

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
npm run google:auth  # one-time Google OAuth token issuance
npm run check:drive  # verify Drive folder + references.md connectivity
```

There is **no test suite and no linter**. `npm run typecheck` is the verification
gate — always run it after code changes.

## Source layout (`src/`)

| File | Responsibility |
|------|----------------|
| `server.ts` | Express entry point. Routes `/healthz`, `/`, `GET/POST /line/webhook`. Verifies LINE signature, ACKs `200` immediately, then archives events async. |
| `archive.ts` | Orchestrator. `archiveEvent()` decides file-vs-text, drives extraction → summary → Drive upload → index append. Owns file-naming, label cleanup, and Japan-timezone date formatting. |
| `line.ts` | LINE HMAC-SHA256 signature verification + message content download. |
| `drive.ts` | Google Drive client (OAuth or service account), folder ensure/create, buffer upload, and `references.md` get-or-create + append. |
| `summary.ts` | OpenAI summarization → `{ bullets, tags }`. Degrades gracefully (never throws) when key missing or API fails. |
| `web.ts` | Fetch URL, extract readable text + build Markdown snapshot, plus `extractUrls()` regex. |
| `pdf.ts` | PDF → normalized text. |
| `config.ts` | Loads/validates env into `AppConfig`. |
| `types.ts` | Shared types: `LineWebhookEvent`, `LineMessage`, `ArchiveEntry`. |
| `google-auth.ts` | Standalone OAuth flow: opens a local callback server, writes token JSON. |
| `check-drive.ts` | Standalone connectivity diagnostic. |

## Key conventions and invariants

- **ESM imports use `.js` extensions** even for TS source (e.g.
  `import { loadConfig } from "./config.js"`). NodeNext resolution requires this —
  do not drop the extension or use `.ts`.
- **Always `dotenv.config({ override: true })`** at the top of entry points
  (`server.ts`, `check-drive.ts`, `google-auth.ts`). `override: true` is
  deliberate: a stale env var in the parent shell must not win over `.env`.
- **Dates/folders use Japan time (`Asia/Tokyo`)** via `Intl.DateTimeFormat`.
  Use the existing `getJapanDateParts` / `formatYearMonth` / `formatDateForFile`
  helpers in `archive.ts`; do not reintroduce UTC `getMonth()`-style code.
- **Drive layout is fixed:**
  ```
  <root folder>/
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
  files. Pin the correct file via `GOOGLE_DRIVE_INDEX_FILE_ID`. Appends are
  read-modify-write (download full text, append entry, re-upload).
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

Two Google Drive auth modes, selected in `config.ts` / `drive.ts`:

- **OAuth (recommended for personal Drive)** — set `GOOGLE_OAUTH_CLIENT_JSON`
  (desktop-app client) and run `npm run google:auth` to produce
  `secrets/google-oauth-token.json`. Service accounts hit
  `storageQuotaExceeded` on personal My Drive, so OAuth is preferred.
- **Service account** — set `GOOGLE_SERVICE_ACCOUNT_JSON`; only suitable for
  Google Workspace shared drives.

LINE webhook requests are authenticated by HMAC signature
(`x-line-signature`) using `LINE_CHANNEL_SECRET`.

## Configuration (`.env`)

See `.env.example`. Required: `LINE_CHANNEL_SECRET`,
`LINE_CHANNEL_ACCESS_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`, and one of the Google
auth vars. Optional: `GOOGLE_DRIVE_INDEX_FILE_ID`, `OPENAI_API_KEY`,
`OPENAI_MODEL` (default `gpt-4.1-mini`), `PORT` (default `3000`).

After editing `.env`, **restart `npm run dev`** — it does not hot-reload env.

## Git hygiene

`.env`, `secrets/`, `node_modules/`, `dist/`, `tmp/` are gitignored. **Never
commit secrets**, OAuth tokens, or service-account JSON, and never paste secret
values into code, docs, commit messages, or chat.

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
