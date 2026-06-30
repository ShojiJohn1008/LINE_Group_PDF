import { Readable } from "node:stream";
import fs from "node:fs";
import { google, drive_v3 } from "googleapis";

export const ARCHIVE_ROOT_FOLDER_NAME = "LINE資料アーカイブ";
const INDEX_FILE_NAME = "references.md";

// googleapis bundles its own copy of google-auth-library. Derive the OAuth2
// client type from `google.auth.OAuth2` so it agrees with what `google.drive`
// expects and with the clients oauth.ts builds — avoids cross-package type clash.
export type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

export type DriveClient = {
  drive: drive_v3.Drive;
  rootFolderId: string;
  indexFileId?: string;
};

export function createDriveClient(
  auth: OAuthClient,
  rootFolderId: string,
  indexFileId?: string
): DriveClient {
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId,
    indexFileId
  };
}

// First-connect provisioning: create (or reuse) the app-owned archive folder and
// references.md in the user's Drive. With the drive.file scope the app only ever
// sees files it created, so list/find here only matches our own artifacts.
export async function provisionArchive(
  auth: OAuthClient
): Promise<{ rootFolderId: string; indexFileId: string }> {
  const drive = google.drive({ version: "v3", auth });
  const rootFolderId = await ensureRootFolder(drive);
  const client: DriveClient = { drive, rootFolderId };
  const indexFileId = await getOrCreateIndexFile(client);
  return { rootFolderId, indexFileId };
}

async function ensureRootFolder(drive: drive_v3.Drive): Promise<string> {
  const existing = await drive.files.list({
    q: [
      `name = '${escapeDriveQuery(ARCHIVE_ROOT_FOLDER_NAME)}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
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

  const created = await drive.files.create({
    requestBody: {
      name: ARCHIVE_ROOT_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder"
    },
    fields: "id",
    supportsAllDrives: true
  });

  if (!created.data.id) {
    throw new Error("Failed to create archive root folder");
  }

  return created.data.id;
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
    try {
      const existing = await client.drive.files.get({
        fileId: client.indexFileId,
        fields: "id, trashed",
        supportsAllDrives: true
      });
      if (existing.data.id && !existing.data.trashed) {
        return existing.data.id;
      }
      if (existing.data.id && existing.data.trashed) {
        const restored = await client.drive.files.update({
          fileId: existing.data.id,
          requestBody: { trashed: false },
          fields: "id",
          supportsAllDrives: true
        });
        if (restored.data.id) {
          return restored.data.id;
        }
      }
    } catch {
      client.indexFileId = undefined;
    }
  }

  const existing = await client.drive.files.list({
    q: [
      `'${client.rootFolderId}' in parents`,
      `name = '${INDEX_FILE_NAME}'`,
      "trashed = false"
    ].join(" and "),
    fields: "files(id, name, mimeType)",
    spaces: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  const found = existing.data.files?.find((file) => !isGoogleWorkspaceFile(file.mimeType));
  if (found?.id) {
    client.indexFileId = found.id;
    return found.id;
  }

  const created = await client.drive.files.create({
    requestBody: {
      name: INDEX_FILE_NAME,
      parents: [client.rootFolderId]
    },
    media: {
      mimeType: "text/markdown",
      body: Readable.from(Buffer.from(`# ${ARCHIVE_ROOT_FOLDER_NAME}\n`, "utf8"))
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

// Non-destructive unsend handling: mark the index entries for the given Drive
// file ids as revoked (append a note to their heading). The stored files are
// left in place. Entries are matched via their "- Drive file ID: <id>" line.
export async function annotateUnsent(client: DriveClient, driveFileIds: string[]): Promise<void> {
  if (!driveFileIds.length) {
    return;
  }
  const indexFileId = await getOrCreateIndexFile(client);
  const current = await downloadTextFile(client, indexFileId);
  const lines = current.split("\n");
  const ids = new Set(driveFileIds);
  const mark = "（送信取消済み）";

  for (let i = 0; i < lines.length; i++) {
    // Current format: hidden `<!-- id:X -->`. Legacy format: `- Drive file ID: X`.
    const hidden = lines[i].match(/^<!--\s*id:(.+?)\s*-->$/);
    const legacy = lines[i].match(/^- Drive file ID:\s*(.+?)\s*$/);
    const id = hidden?.[1] ?? legacy?.[1];
    if (!id || !ids.has(id)) {
      continue;
    }
    for (let j = i; j >= 0; j--) {
      if (lines[j].startsWith("### ")) {
        if (!lines[j].includes(mark)) {
          lines[j] = `${lines[j]} ${mark}`;
        }
        break;
      }
    }
  }

  const next = lines.join("\n");
  if (next === current) {
    return;
  }
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
