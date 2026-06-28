import dotenv from "dotenv";
import express from "express";
import { archiveEvent, ArchiveDeps } from "./archive.js";
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
import { createTenantStore } from "./store.js";
import { LineMessage, LineWebhookBody, LineWebhookEvent } from "./types.js";

dotenv.config({ override: true });

const config = loadConfig();
const store = createTenantStore(config.tenantStorePath, config.tenantEncryptionKey);
const deps: ArchiveDeps = { config, store };

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
    handleEvent(event).catch((error) => {
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
    store.upsertConnection(verified.groupId, { refreshToken, rootFolderId, indexFileId });

    await pushText(
      verified.groupId,
      "接続が完了しました。これ以降、グループに共有されたPDF・URLを自動でGoogle Driveに保存し、要約付きで索引化します。",
      config.lineChannelAccessToken
    ).catch(() => undefined);

    res.send("Google Driveの接続が完了しました。LINEに戻ってください。");
  } catch (error) {
    console.error("OAuth callback failed", formatErrorForLog(error));
    res.status(500).send("接続に失敗しました。時間をおいて、もう一度お試しください。");
  }
});

app.listen(config.port, () => {
  console.log(`LINE archive server listening on :${config.port}`);
});

async function handleEvent(event: LineWebhookEvent): Promise<void> {
  // Bot added to a group → prompt for Drive connection.
  if (event.type === "join") {
    await promptConnect(event);
    return;
  }

  if (event.type === "message") {
    const groupId = event.source?.groupId || event.source?.roomId;
    // Not connected yet + the user typed the connect command → send the link.
    if (groupId && !store.isConnected(groupId) && isConnectCommand(event.message)) {
      await promptConnect(event);
      return;
    }
    await archiveEvent(event, deps);
  }
}

async function promptConnect(event: LineWebhookEvent): Promise<void> {
  const groupId = event.source?.groupId || event.source?.roomId;
  if (!groupId) {
    return;
  }
  const text = ["資料を保存するGoogle Driveを接続してください。", buildConnectUrl(config, groupId)].join("\n");
  if (event.replyToken) {
    await replyText(event.replyToken, text, config.lineChannelAccessToken);
  } else {
    await pushText(groupId, text, config.lineChannelAccessToken);
  }
}

// Trigger only on an explicit command: the whole message is "/接続" (or
// "/connect"). A command prefix avoids firing on "接続" used inside ordinary
// conversation.
const CONNECT_COMMAND = /^\/(接続|せつぞく|connect)$/i;

function isConnectCommand(message: LineMessage | undefined): boolean {
  if (!message || message.type !== "text" || typeof message.text !== "string") {
    return false;
  }
  return CONNECT_COMMAND.test(message.text.trim());
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
