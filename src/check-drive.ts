import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { createDriveClient, getOrCreateIndexFile } from "./drive.js";

dotenv.config({ override: true });

try {
  const config = loadConfig();
  const client = createDriveClient(
    {
      serviceAccountJson: config.googleServiceAccountJson,
      oauthClientJson: config.googleOAuthClientJson,
      oauthTokenJson: config.googleOAuthTokenJson
    },
    config.googleDriveFolderId,
    config.googleDriveIndexFileId
  );

  const folder = await client.drive.files.get({
    fileId: config.googleDriveFolderId,
    fields: "id, name, mimeType",
    supportsAllDrives: true
  });

  console.log("drive_folder", folder.data.name || folder.data.id || "found");

  const indexFileId = await getOrCreateIndexFile(client);
  console.log("references_md", indexFileId ? "ready" : "missing");
} catch (error) {
  console.error(formatDriveError(error));
  process.exit(1);
}

function formatDriveError(error: unknown): string {
  const maybeError = error as {
    message?: string;
    code?: number;
    response?: {
      data?: {
        error?: {
          code?: number;
          message?: string;
          errors?: Array<{ reason?: string }>;
        };
      };
    };
  };
  const apiError = maybeError.response?.data?.error;
  const code = apiError?.code || maybeError.code || "unknown";
  const reason = apiError?.errors?.[0]?.reason;
  const message = apiError?.message || maybeError.message || String(error);

  return [
    `drive_check_failed code=${code}${reason ? ` reason=${reason}` : ""}`,
    message,
    "",
    "よくある原因:",
    "- Google Drive APIが未有効",
    "- GOOGLE_DRIVE_FOLDER_IDのフォルダを認証ユーザー/サービスアカウントに共有していない",
    "- 個人用マイドライブにサービスアカウントで新規作成しようとしている",
    "",
    "個人用Google Driveでは、サービスアカウントではなくOAuth方式を推奨します。"
  ].join("\n");
}
