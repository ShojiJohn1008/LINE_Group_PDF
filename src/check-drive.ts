import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, redirectUri, GOOGLE_DRIVE_SCOPE } from "./config.js";
import { getOAuthClientInfo, readJsonInput } from "./drive.js";

dotenv.config({ override: true });

// Provider-side preflight: validates the shared config a multi-tenant deploy
// needs before any group connects. Per-tenant Drive connectivity is established
// at OAuth time, not here.
try {
  const config = loadConfig();

  const clientInfo = getOAuthClientInfo(readJsonInput(config.googleOAuthClientJson));
  console.log("oauth_client", clientInfo.client_id ? "ok" : "missing");
  console.log("oauth_scope", GOOGLE_DRIVE_SCOPE);
  console.log("redirect_uri", redirectUri(config));
  console.log("public_base_url", config.publicBaseUrl);

  fs.mkdirSync(path.dirname(config.tenantStorePath), { recursive: true });
  fs.accessSync(path.dirname(config.tenantStorePath), fs.constants.W_OK);
  console.log("tenant_store", "writable", config.tenantStorePath);

  console.log("openai", config.openAiApiKey ? "configured" : "not set (summaries degrade)");
  console.log("free_monthly_limit", config.freeMonthlyLimit);
  console.log("check", "ok");
} catch (error) {
  console.error(formatError(error));
  process.exit(1);
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `config_check_failed: ${message}`,
    "",
    "確認:",
    "- LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN",
    "- GOOGLE_OAUTH_CLIENT_JSON（Webアプリ型のOAuthクライアント）",
    "- PUBLIC_BASE_URL（OAuthリダイレクトURIのベース）",
    "- TENANT_ENCRYPTION_KEY（openssl rand -hex 32）",
    "",
    `Google OAuthクライアントの承認済みリダイレクトURIに ${"<PUBLIC_BASE_URL>"}/oauth/callback を登録してください。`
  ].join("\n");
}
