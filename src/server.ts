import dotenv from "dotenv";
import express from "express";
import { archiveEvent, ArchiveDeps, handleUnsend } from "./archive.js";
import { loadConfig } from "./config.js";
import { verifyLineSignature } from "./line.js";
import { pushText, replyText } from "./line-push.js";
import {
  authedClient,
  buildConnectUrl,
  buildGoogleAuthUrl,
  exchangeCode,
  verifyState
} from "./oauth.js";
import { provisionArchive } from "./drive.js";
import { createKeyedQueue } from "./queue.js";
import { provisionDashboard } from "./sheet.js";
import { createTenantStore, TenantStore } from "./store.js";
import { createFirestoreTenantStore } from "./store-firestore.js";
import { formatDateForFile } from "./time.js";
import { LineMessage, LineWebhookBody, LineWebhookEvent } from "./types.js";
import { renderDashboardHtml } from "./view.js";

dotenv.config({ override: true });

const config = loadConfig();
const store: TenantStore =
  config.tenantBackend === "firestore"
    ? await createFirestoreTenantStore({
        encryptionKey: config.tenantEncryptionKey,
        projectId: config.googleCloudProject,
        databaseId: config.firestoreDatabaseId
      })
    : createTenantStore(config.tenantStorePath, config.tenantEncryptionKey);
const deps: ArchiveDeps = { config, store };
const eventQueue = createKeyedQueue();

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "line-group-pdf-archive",
    webhook: "/line/webhook"
  });
});

app.get("/line/webhook", (_req, res) => {
  res.json({
    ok: true,
    message: "LINE webhook endpoint is ready. LINE Developers must call this URL with POST."
  });
});

app.post("/line/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.header("x-line-signature");
  const rawBody = req.body as Buffer;

  if (!verifyLineSignature(rawBody, config.lineChannelSecret, signature)) {
    res.status(401).json({ ok: false, error: "invalid signature" });
    return;
  }

  const body = JSON.parse(rawBody.toString("utf8")) as LineWebhookBody;
  res.status(200).json({ ok: true });

  for (const event of body.events || []) {
    // Serialize per group: index appends are read-modify-write, so concurrent
    // events in the same group would overwrite each other's entries.
    const key = event.source?.groupId || event.source?.roomId || event.source?.userId || "global";
    eventQueue.run(key, () => handleEvent(event)).catch((error) => {
      console.error("Failed to handle LINE event", {
        eventType: event.type,
        messageType: event.message?.type,
        error: formatErrorForLog(error)
      });
    });
  }
});

// Step 1 of OAuth: the bot's link lands here. Validate state, then hand off to
// Google's consent screen (the only Google interaction the user ever sees).
app.get("/connect", (req, res) => {
  const state = String(req.query.state || "");
  if (!verifyState(state, config.stateSecret)) {
    res.status(400).send("リンクが無効か、期限切れです。グループでもう一度「/接続」と送ってください。");
    return;
  }
  res.redirect(buildGoogleAuthUrl(config, state));
});

// Step 2: Google redirects back with an auth code. Exchange it, provision the
// archive folder in the user's Drive, persist the tenant, and notify the group.
app.get("/oauth/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const verified = verifyState(state, config.stateSecret);
  if (!verified || !code) {
    res.status(400).send("接続情報が無効です。グループでもう一度「/接続」と送ってください。");
    return;
  }

  try {
    const refreshToken = await exchangeCode(config, code);
    const auth = authedClient(config, refreshToken);
    const { rootFolderId, indexFileId } = await provisionArchive(auth);
    // Best-effort: a missing/disabled Sheets API must not fail the connection.
    const sheetId = await provisionDashboard(auth, rootFolderId).catch((error) => {
      console.error("dashboard provisioning skipped", formatErrorForLog(error));
      return undefined;
    });
    store.upsertConnection(verified.groupId, { refreshToken, rootFolderId, indexFileId, sheetId });

    const viewUrl = viewUrlFor(verified.groupId);
    const doneText = [
      "接続が完了しました。これ以降、グループに共有されたPDF・URLを自動でGoogle Driveに保存し、要約付きで索引化します。",
      viewUrl ? `\n資料一覧ダッシュボード（いつでも「/一覧」で再表示）:\n${viewUrl}` : ""
    ].join("");
    await pushText(verified.groupId, doneText, config.lineChannelAccessToken).catch(() => undefined);

    res.send("Google Driveの接続が完了しました。LINEに戻ってください。");
  } catch (error) {
    console.error("OAuth callback failed", formatErrorForLog(error));
    res.status(500).send("接続に失敗しました。時間をおいて、もう一度お試しください。");
  }
});

// Read-only web dashboard, gated by an unguessable per-group token.
app.get("/view/:token", (req, res) => {
  const tenant = store.getByViewToken(req.params.token);
  if (!tenant) {
    res.status(404).send("ページが見つかりません。リンクが無効か、失効しています。");
    return;
  }
  const items = store.listArchived(tenant.groupId).map((item) => ({
    kind: item.kind,
    title: item.title,
    date: formatDashboardDate(item.postedAt || item.createdAt),
    tags: item.tags || [],
    summary: item.summary || [],
    driveUrl: item.driveUrl || "",
    originalUrl: item.originalUrl || "",
    category: item.category || "",
    type: item.resourceType || "",
    unsent: item.unsent
  }));
  res.set("content-type", "text/html; charset=utf-8");
  res.send(renderDashboardHtml({ title: "資料アーカイブ", items }));
});

function formatDashboardDate(value: string | undefined): string {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : formatDateForFile(date);
}

app.listen(config.port, () => {
  console.log(`LINE archive server listening on :${config.port}`);
});

function viewUrlFor(groupId: string): string | undefined {
  const token = store.get(groupId)?.viewToken;
  return token ? `${config.publicBaseUrl}/view/${token}` : undefined;
}

async function handleEvent(event: LineWebhookEvent): Promise<void> {
  // Added as a friend (1:1). No group to connect yet → explain how to start.
  if (event.type === "follow") {
    await sendFollowIntro(event);
    return;
  }

  // Bot added to a group → introduce the service and send the connect link.
  if (event.type === "join") {
    await sendGroupWelcome(event);
    return;
  }

  // A message was revoked → reflect it in the index.
  if (event.type === "unsend") {
    await handleUnsend(event, deps);
    return;
  }

  if (event.type === "message") {
    const groupId = event.source?.groupId || event.source?.roomId;
    // The connect command works whether or not the group is already connected,
    // so a tenant can reconnect / switch to a different Drive.
    if (groupId && isConnectCommand(event.message)) {
      await sendConnectLink(event);
      return;
    }
    // Dashboard command → reply with the read-only web view link.
    if (groupId && isDashboardCommand(event.message)) {
      await sendDashboardLink(event, groupId);
      return;
    }
    await archiveEvent(event, deps);
  }
}

const FOLLOW_INTRO = [
  "友だち追加ありがとうございます。",
  "このBotはLINEグループに共有されたPDF・URLをGoogle Driveへ自動保存し、要約つきの索引（references.md）を作ります。",
  "",
  "使い方",
  "1. このアカウントを、資料を共有したいグループに招待します。",
  "2. グループに表示される接続リンクから、保存先のGoogle Driveを接続します（どなたか一度だけ）。",
  "3. あとはいつも通りPDFやURLを投稿するだけ。自動で保存・要約します。",
  "",
  "※保存先は各グループご自身のGoogle Driveです。データは手元に残ります。"
].join("\n");

async function sendFollowIntro(event: LineWebhookEvent): Promise<void> {
  if (event.replyToken) {
    await replyText(event.replyToken, FOLLOW_INTRO, config.lineChannelAccessToken);
  }
}

async function sendGroupWelcome(event: LineWebhookEvent): Promise<void> {
  const groupId = event.source?.groupId || event.source?.roomId;
  if (!groupId) {
    return;
  }
  const text = [
    "はじめまして。このグループに共有されたPDF・URLを、Google Driveに自動保存して要約つきで索引化します。保存先には一覧Markdownと、並べ替え・検索できるスプレッドシート（ダッシュボード）ができます。",
    "",
    "まず保存先のGoogle Driveを接続してください（どなたか一度だけ）。",
    buildConnectUrl(config, groupId),
    "",
    "接続後は、いつも通り資料を投稿するだけでOKです。リンクが切れたら「/接続」と送ると再表示します。"
  ].join("\n");
  await say(event, groupId, text);
}

async function sendConnectLink(event: LineWebhookEvent): Promise<void> {
  const groupId = event.source?.groupId || event.source?.roomId;
  if (!groupId) {
    return;
  }
  const text = ["資料を保存するGoogle Driveを接続してください。", buildConnectUrl(config, groupId)].join("\n");
  await say(event, groupId, text);
}

// Prefer reply (free, uses the event's replyToken); fall back to push.
async function say(event: LineWebhookEvent, to: string, text: string): Promise<void> {
  if (event.replyToken) {
    await replyText(event.replyToken, text, config.lineChannelAccessToken);
  } else {
    await pushText(to, text, config.lineChannelAccessToken);
  }
}

// Trigger only on an explicit command: the whole message is "/接続" (or
// "/connect"). A command prefix avoids firing on "接続" used inside ordinary
// conversation.
const CONNECT_COMMAND = /^\/(接続|せつぞく|connect)$/i;
const DASHBOARD_COMMAND = /^\/(一覧|ダッシュボード|dashboard)$/i;

function isConnectCommand(message: LineMessage | undefined): boolean {
  return matchesCommand(message, CONNECT_COMMAND);
}

function isDashboardCommand(message: LineMessage | undefined): boolean {
  return matchesCommand(message, DASHBOARD_COMMAND);
}

function matchesCommand(message: LineMessage | undefined, pattern: RegExp): boolean {
  if (!message || message.type !== "text" || typeof message.text !== "string") {
    return false;
  }
  return pattern.test(message.text.trim());
}

async function sendDashboardLink(event: LineWebhookEvent, groupId: string): Promise<void> {
  const url = viewUrlFor(groupId);
  const text = url
    ? `資料一覧ダッシュボード:\n${url}`
    : "まだGoogle Driveに接続されていません。「/接続」で接続してください。";
  await say(event, groupId, text);
}

function formatErrorForLog(error: unknown): {
  name: string;
  message: string;
  status?: number;
  code?: string;
} {
  const maybeError = error as {
    name?: string;
    message?: string;
    status?: number;
    code?: string;
  };

  return {
    name: maybeError.name || "Error",
    message: redactApiKey(maybeError.message || String(error)),
    status: maybeError.status,
    code: maybeError.code
  };
}

function redactApiKey(input: string): string {
  return input.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}
