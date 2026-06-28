export type AppConfig = {
  lineChannelSecret: string;
  lineChannelAccessToken: string;
  googleServiceAccountJson?: string;
  googleOAuthClientJson?: string;
  googleOAuthTokenJson?: string;
  googleDriveFolderId: string;
  googleDriveIndexFileId?: string;
  openAiApiKey?: string;
  openAiModel: string;
  port: number;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const googleServiceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || undefined;
  const googleOAuthClientJson = process.env.GOOGLE_OAUTH_CLIENT_JSON || undefined;

  if (!googleServiceAccountJson && !googleOAuthClientJson) {
    throw new Error(
      "Missing Google Drive auth. Set either GOOGLE_OAUTH_CLIENT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON."
    );
  }

  return {
    lineChannelSecret: requireEnv("LINE_CHANNEL_SECRET"),
    lineChannelAccessToken: requireEnv("LINE_CHANNEL_ACCESS_TOKEN"),
    googleServiceAccountJson,
    googleOAuthClientJson,
    googleOAuthTokenJson: process.env.GOOGLE_OAUTH_TOKEN_JSON || "secrets/google-oauth-token.json",
    googleDriveFolderId: requireEnv("GOOGLE_DRIVE_FOLDER_ID"),
    googleDriveIndexFileId: process.env.GOOGLE_DRIVE_INDEX_FILE_ID || undefined,
    openAiApiKey: process.env.OPENAI_API_KEY || undefined,
    openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    port: Number(process.env.PORT || 3000)
  };
}
