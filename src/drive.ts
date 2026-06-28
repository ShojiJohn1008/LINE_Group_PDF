import { Readable } from "node:stream";
import fs from "node:fs";
import { google, drive_v3 } from "googleapis";

export type DriveAuthConfig = {
  serviceAccountJson?: string;
  oauthClientJson?: string;
  oauthTokenJson?: string;
};

export type DriveClient = {
  drive: drive_v3.Drive;
  rootFolderId: string;
  indexFileId?: string;
};

export function createDriveClient(
  authConfig: DriveAuthConfig,
  rootFolderId: string,
  indexFileId?: string
): DriveClient {
  const auth = createGoogleAuth(authConfig);

  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId,
    indexFileId
  };
}

function createGoogleAuth(authConfig: DriveAuthConfig) {
  if (authConfig.oauthClientJson) {
    const clientConfig = readJsonInput(authConfig.oauthClientJson);
    const clientInfo = getOAuthClientInfo(clientConfig);
    const oauth2Client = new google.auth.OAuth2(
      clientInfo.client_id,
      clientInfo.client_secret,
      "http://127.0.0.1:53682/oauth2callback"
    );

    if (!authConfig.oauthTokenJson || !fs.existsSync(authConfig.oauthTokenJson)) {
      throw new Error(
        "Missing Google OAuth token. Run `npm run google:auth` before using Google Drive."
      );
    }

    oauth2Client.setCredentials(readJsonInput(authConfig.oauthTokenJson));
    return oauth2Client;
  }

  if (authConfig.serviceAccountJson) {
    const credentials = readJsonInput(authConfig.serviceAccountJson);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
  }

  throw new Error("Missing Google Drive auth config.");
}

export function readJsonInput(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  return JSON.parse(fs.readFileSync(trimmed, "utf8")) as Record<string, unknown>;
}

export function getOAuthClientInfo(clientConfig: Record<string, unknown>): {
  client_id: string;
  client_secret: string;
} {
  const maybeConfig = clientConfig.installed || clientConfig.web;
  if (!isRecord(maybeConfig)) {
    throw new Error("OAuth client JSON must contain an `installed` or `web` object.");
  }

  const clientId = maybeConfig.client_id;
  const clientSecret = maybeConfig.client_secret;

  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error("OAuth client JSON is missing client_id or client_secret.");
  }

  return {
    client_id: clientId,
    client_secret: clientSecret
  };
}

export async function ensureFolder(
  client: DriveClient,
  name: string,
  parentFolderId = client.rootFolderId
): Promise<string> {
  const existing = await client.drive.files.list({
    q: [
      `'${parentFolderId}' in parents`,
      "mimeType = 'application/vnd.google-apps.folder'",
      `name = '${escapeDriveQuery(name)}'`,
      "trashed = false"
    ].join(" and "),
    fields: "files(id, name)",
    spaces: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  const found = existing.data.files?.[0];
  if (found?.id) {
    return found.id;
  }

  const created = await client.drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId]
    },
    fields: "id",
    supportsAllDrives: true
  });

  if (!created.data.id) {
    throw new Error(`Failed to create Drive folder: ${name}`);
  }

  return created.data.id;
}

export async function uploadBuffer(
  client: DriveClient,
  folderId: string,
  name: string,
  mimeType: string,
  body: Buffer
): Promise<{ id: string; webViewLink?: string }> {
  const uploaded = await client.drive.files.create({
    requestBody: {
      name,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: Readable.from(body)
    },
    fields: "id, webViewLink",
    supportsAllDrives: true
  });

  if (!uploaded.data.id) {
    throw new Error(`Failed to upload Drive file: ${name}`);
  }

  return {
    id: uploaded.data.id,
    webViewLink: uploaded.data.webViewLink ?? undefined
  };
}

export async function getOrCreateIndexFile(client: DriveClient): Promise<string> {
  if (client.indexFileId) {
    return client.indexFileId;
  }

  const existing = await client.drive.files.list({
    q: [
      `'${client.rootFolderId}' in parents`,
      `name = 'references.md'`,
      "trashed = false"
    ].join(" and "),
    fields: "files(id, name, mimeType)",
    spaces: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  const found = existing.data.files?.find((file) => !isGoogleWorkspaceFile(file.mimeType));
  if (found?.id) {
    return found.id;
  }

  const created = await client.drive.files.create({
    requestBody: {
      name: "references.md",
      parents: [client.rootFolderId]
    },
    media: {
      mimeType: "text/markdown",
      body: Readable.from(Buffer.from("# LINE資料アーカイブ\n", "utf8"))
    },
    fields: "id",
    supportsAllDrives: true
  });

  if (!created.data.id) {
    throw new Error("Failed to create references.md");
  }

  client.indexFileId = created.data.id;
  return created.data.id;
}

export async function appendToIndex(client: DriveClient, markdown: string): Promise<void> {
  const indexFileId = await getOrCreateIndexFile(client);
  const current = await downloadTextFile(client, indexFileId);
  const next = `${current.trimEnd()}\n\n${markdown.trim()}\n`;

  await client.drive.files.update({
    fileId: indexFileId,
    media: {
      mimeType: "text/markdown",
      body: Readable.from(Buffer.from(next, "utf8"))
    },
    supportsAllDrives: true
  });
}

async function downloadTextFile(client: DriveClient, fileId: string): Promise<string> {
  const response = await client.drive.files.get(
    {
      fileId,
      alt: "media",
      supportsAllDrives: true
    },
    {
      responseType: "arraybuffer"
    }
  );

  return Buffer.from(response.data as ArrayBuffer).toString("utf8");
}

function escapeDriveQuery(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGoogleWorkspaceFile(mimeType: string | null | undefined): boolean {
  return Boolean(mimeType?.startsWith("application/vnd.google-apps."));
}
