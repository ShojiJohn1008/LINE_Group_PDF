import dotenv from "dotenv";
import express from "express";
import { loadConfig } from "./config.js";
import { archiveEvent } from "./archive.js";
import { verifyLineSignature } from "./line.js";
import { LineWebhookBody } from "./types.js";

dotenv.config({ override: true });

const config = loadConfig();
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

app.post(
  "/line/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.header("x-line-signature");
    const rawBody = req.body as Buffer;

    if (!verifyLineSignature(rawBody, config.lineChannelSecret, signature)) {
      res.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }

    const body = JSON.parse(rawBody.toString("utf8")) as LineWebhookBody;
    res.status(200).json({ ok: true });

    for (const event of body.events || []) {
      archiveEvent(event, config).catch((error) => {
        console.error("Failed to archive LINE event", {
          eventType: event.type,
          messageType: event.message?.type,
          error: formatErrorForLog(error)
        });
      });
    }
  }
);

app.listen(config.port, () => {
  console.log(`LINE archive server listening on :${config.port}`);
});

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
