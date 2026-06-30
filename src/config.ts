export type AppConfig = {
  // LINE (provider's single official account)
  lineChannelSecret: string;
  lineChannelAccessToken: string;
  // Google OAuth app (provider-owned, shared by all tenants).
  // Must be a "Web application" client with `${publicBaseUrl}/oauth/callback`
  // registered as an authorized redirect URI.
  googleOAuthClientJson: string;
  // Summaries (provider-owned, metered cost)
  openAiApiKey?: string;
  openAiModel: string;
  // Server
  port: number;
  // Public base URL used to build connect links and the OAuth redirect URI.
  // For local pilots this is the ngrok URL (e.g. https://xxxx.ngrok-free.app).
  publicBaseUrl: string;
  // Multi-tenant store backend: "json" (file, default/local) or "firestore"
  // (Cloud Run, where the filesystem is ephemeral).
  tenantBackend: "json" | "firestore";
  tenantStorePath: string;
  // Firestore project id (optional; auto-detected from the runtime on Cloud Run).
  googleCloudProject?: string;
  // Firestore database id (optional; defaults to "(default)" when omitted).
  firestoreDatabaseId?: string;
  // 32-byte key (hex or base64) used to encrypt tenant refresh tokens at rest.
  tenantEncryptionKey: string;
  // Secret used to sign OAuth `state` tokens. Falls back to the LINE secret.
  stateSecret: string;
  // Free tier: summaries/saves per tenant per calendar month (JST).
  freeMonthlyLimit: number;
};

// Drive scope: only files the app creates. Avoids Google's restricted-scope
// (CASA) security assessment and never touches the user's other files.
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const lineChannelSecret = requireEnv("LINE_CHANNEL_SECRET");

  return {
    lineChannelSecret,
    lineChannelAccessToken: requireEnv("LINE_CHANNEL_ACCESS_TOKEN"),
    googleOAuthClientJson: requireEnv("GOOGLE_OAUTH_CLIENT_JSON"),
    openAiApiKey: process.env.OPENAI_API_KEY || undefined,
    openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    port: Number(process.env.PORT || 3000),
    publicBaseUrl: requireEnv("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    tenantBackend: process.env.TENANT_BACKEND === "firestore" ? "firestore" : "json",
    tenantStorePath: process.env.TENANT_STORE_PATH || "data/tenants.json",
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT || undefined,
    firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || undefined,
    tenantEncryptionKey: requireEnv("TENANT_ENCRYPTION_KEY"),
    stateSecret: process.env.OAUTH_STATE_SECRET || lineChannelSecret,
    freeMonthlyLimit: Number(process.env.FREE_MONTHLY_LIMIT || 50)
  };
}

export function redirectUri(config: AppConfig): string {
  return `${config.publicBaseUrl}/oauth/callback`;
}
