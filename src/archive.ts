import path from "node:path";
import { AppConfig } from "./config.js";
import {
  annotateUnsent,
  appendToIndex,
  createDriveClient,
  DriveClient,
  ensureFolder,
  uploadBuffer
} from "./drive.js";
import { downloadLineMessageContent } from "./line.js";
import { pushText } from "./line-push.js";
import { authedClient } from "./oauth.js";
import { extractPdfText } from "./pdf.js";
import { TenantRecord, TenantStore } from "./store.js";
import { summarizeContent } from "./summary.js";
import { formatDateForFile, formatYearMonth } from "./time.js";
import { ArchiveEntry, LineMessage, LineWebhookEvent } from "./types.js";
import { extractUrls, readWebPage } from "./web.js";

export type ArchiveDeps = {
  config: AppConfig;
  store: TenantStore;
};

export async function archiveEvent(event: LineWebhookEvent, deps: ArchiveDeps): Promise<void> {
  if (event.type !== "message" || !event.message) {
    return;
  }

  // Group-scoped product: events are keyed by the group (or room) they came from.
  const groupId = event.source?.groupId || event.source?.roomId;
  if (!groupId) {
    return;
  }

  const tenant = deps.store.get(groupId);
  if (!tenant) {
    // Not connected to a Drive yet. The webhook handler prompts for connection
    // on join / keyword; we simply do not archive until then.
    return;
  }

  const drive = tenantDrive(deps.config, deps.store, tenant);

  if (isFileMessage(event.message)) {
    await archiveFile(event, event.message, deps, tenant, groupId, drive);
  }

  if (isTextMessage(event.message)) {
    const urls = extractUrls(event.message.text);
    for (const url of urls) {
      await archiveUrl(event, deps, tenant, groupId, drive, url);
    }
  }
}

async function archiveFile(
  event: LineWebhookEvent,
  message: Extract<LineMessage, { type: "file" }>,
  deps: ArchiveDeps,
  tenant: TenantRecord,
  groupId: string,
  drive: DriveClient
): Promise<void> {
  const postedAt = new Date(event.timestamp);
  const dedupKey = `file:${message.fileName}:${message.fileSize ?? "?"}`;
  if (deps.store.isArchived(groupId, dedupKey)) {
    console.log("skip duplicate file", { groupId, fileName: message.fileName });
    return;
  }
  if (!(await withinQuota(deps, tenant, groupId, postedAt))) {
    return;
  }

  const content = await downloadLineMessageContent(message.id, deps.config.lineChannelAccessToken);
  const mimeType = guessMimeType(message.fileName);
  const text = mimeType === "application/pdf" ? await safeExtractPdfText(content) : "";
  const summary = await summarizeContent({
    apiKey: deps.config.openAiApiKey,
    model: deps.config.openAiModel,
    title: message.fileName,
    sourceKind: mimeType === "application/pdf" ? "pdf" : "file",
    text
  });
  const filesRootFolderId = await ensureFolder(drive, "files");
  const filesMonthFolderId = await ensureFolder(drive, formatYearMonth(postedAt), filesRootFolderId);
  const fileName = buildStoredFileName({
    date: postedAt,
    kind: mimeType === "application/pdf" ? "PDF" : "FILE",
    label: bestContentLabel(summary.bullets, message.fileName),
    extension: path.extname(message.fileName) || ".bin"
  });
  const uploaded = await uploadBuffer(drive, filesMonthFolderId, fileName, mimeType, content);

  await appendToIndex(
    drive,
    renderArchiveEntry({
      kind: mimeType === "application/pdf" ? "pdf" : "file",
      postedAt,
      senderId: event.source?.userId || "unknown",
      groupId,
      title: message.fileName,
      driveUrl: uploaded.webViewLink,
      driveFileId: uploaded.id,
      summary: summary.bullets,
      tags: summary.tags,
      notes: text
        ? undefined
        : ["PDF本文を抽出できない場合は、スキャンPDFまたは画像主体の資料の可能性があります。"]
    })
  );

  deps.store.incrementUsage(groupId, postedAt);
  deps.store.recordArchive(groupId, {
    messageId: message.id,
    dedupKey,
    driveFileId: uploaded.id,
    title: message.fileName,
    kind: mimeType === "application/pdf" ? "pdf" : "file"
  });
}

async function archiveUrl(
  event: LineWebhookEvent,
  deps: ArchiveDeps,
  tenant: TenantRecord,
  groupId: string,
  drive: DriveClient,
  url: string
): Promise<void> {
  const postedAt = new Date(event.timestamp);
  const dedupKey = `url:${normalizeUrlForDedup(url)}`;
  if (deps.store.isArchived(groupId, dedupKey)) {
    console.log("skip duplicate url", { groupId, url });
    return;
  }
  if (!(await withinQuota(deps, tenant, groupId, postedAt))) {
    return;
  }

  const page = await readWebPage(url);
  const summary = await summarizeContent({
    apiKey: deps.config.openAiApiKey,
    model: deps.config.openAiModel,
    title: page.title,
    sourceKind: "url",
    text: page.text
  });
  const webRootFolderId = await ensureFolder(drive, "web");
  const webMonthFolderId = await ensureFolder(drive, formatYearMonth(postedAt), webRootFolderId);
  const snapshotName = buildStoredFileName({
    date: postedAt,
    kind: "URL",
    label: bestContentLabel(summary.bullets, page.title),
    extension: ".md"
  });
  const uploaded = await uploadBuffer(
    drive,
    webMonthFolderId,
    snapshotName,
    "text/markdown",
    Buffer.from(page.markdownSnapshot, "utf8")
  );

  await appendToIndex(
    drive,
    renderArchiveEntry({
      kind: "url",
      postedAt,
      senderId: event.source?.userId || "unknown",
      groupId,
      title: page.title,
      originalUrl: url,
      driveUrl: uploaded.webViewLink,
      driveFileId: uploaded.id,
      summary: summary.bullets,
      tags: summary.tags
    })
  );

  deps.store.incrementUsage(groupId, postedAt);
  deps.store.recordArchive(groupId, {
    messageId: event.message?.id ?? "unknown",
    dedupKey,
    driveFileId: uploaded.id,
    title: page.title,
    kind: "url"
  });
}

// Strip the fragment so the same article with #anchor isn't re-archived.
function normalizeUrlForDedup(url: string): string {
  return url.split("#")[0].trim();
}

// A user revoked a message (LINE `unsend` event). Mark every artifact archived
// from that message as revoked in the index. Non-destructive: the stored Drive
// files are kept; only references.md is annotated.
export async function handleUnsend(event: LineWebhookEvent, deps: ArchiveDeps): Promise<void> {
  const groupId = event.source?.groupId || event.source?.roomId;
  const messageId = event.unsend?.messageId;
  if (!groupId || !messageId) {
    return;
  }
  const tenant = deps.store.get(groupId);
  if (!tenant) {
    return;
  }
  const items = deps.store.findByMessage(groupId, messageId).filter((item) => !item.unsent);
  if (!items.length) {
    return;
  }
  const drive = tenantDrive(deps.config, deps.store, tenant);
  await annotateUnsent(
    drive,
    items.map((item) => item.driveFileId)
  );
  deps.store.markUnsent(groupId, messageId);
}

// Free tier: stop archiving past the monthly limit. Notify the group once, on
// the first message that crosses the line, to avoid spamming.
async function withinQuota(
  deps: ArchiveDeps,
  tenant: TenantRecord,
  groupId: string,
  when: Date
): Promise<boolean> {
  const used = deps.store.getUsage(groupId, when);
  if (used < deps.config.freeMonthlyLimit) {
    return true;
  }
  if (used === deps.config.freeMonthlyLimit) {
    // Bump once so the "===" notice fires a single time this month.
    deps.store.incrementUsage(groupId, when);
    await pushText(
      groupId,
      `今月の無料枠（${deps.config.freeMonthlyLimit}件）に達しました。来月になると自動的にリセットされます。`,
      deps.config.lineChannelAccessToken
    ).catch(() => undefined);
  }
  return false;
}

function tenantDrive(config: AppConfig, store: TenantStore, tenant: TenantRecord): DriveClient {
  const refreshToken = store.getRefreshToken(tenant.groupId);
  if (!refreshToken) {
    throw new Error(`Missing refresh token for tenant ${tenant.groupId}`);
  }
  const auth = authedClient(config, refreshToken);
  return createDriveClient(auth, tenant.rootFolderId, tenant.indexFileId);
}

function renderArchiveEntry(entry: ArchiveEntry): string {
  const date = formatDateForFile(entry.postedAt);
  const summaryLines = entry.summary.length
    ? entry.summary.map((item) => `  - ${item}`).join("\n")
    : "  - 要約は未生成です。";
  const tagLine = entry.tags.length ? entry.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ") : "なし";
  const notes = entry.notes?.length ? `\n- 注意:\n${entry.notes.map((note) => `  - ${note}`).join("\n")}` : "";

  return [
    `## ${date}`,
    "",
    `### ${kindLabel(entry.kind)}: ${entry.title}`,
    "",
    `- 投稿日時: ${entry.postedAt.toISOString()}`,
    `- 投稿者: ${entry.senderId}`,
    `- グループ: ${entry.groupId}`,
    entry.originalUrl ? `- 元URL: ${entry.originalUrl}` : undefined,
    entry.driveUrl ? `- 保存先: ${entry.driveUrl}` : undefined,
    entry.driveFileId ? `- Drive file ID: ${entry.driveFileId}` : undefined,
    `- タグ: ${tagLine}`,
    "- 要約:",
    summaryLines,
    notes
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function safeExtractPdfText(content: Buffer): Promise<string> {
  try {
    return await extractPdfText(content);
  } catch (error) {
    console.error("Failed to extract PDF text", error);
    return "";
  }
}

function guessMimeType(fileName: string): string {
  return path.extname(fileName).toLowerCase() === ".pdf" ? "application/pdf" : "application/octet-stream";
}

function buildStoredFileName(params: {
  date: Date;
  kind: "PDF" | "URL" | "FILE";
  label: string;
  extension: string;
}): string {
  const extension = params.extension.startsWith(".") ? params.extension : `.${params.extension}`;
  return [
    formatDateForFile(params.date),
    params.kind,
    sanitizeFileName(params.label)
  ].join("_") + extension.toLowerCase();
}

function sanitizeFileName(input: string): string {
  const sanitized = input
    .replace(/[\\/:*?"<>|#%{}[\]^~`]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (sanitized || "untitled").slice(0, 80);
}

function bestContentLabel(summaryBullets: string[], fallbackTitle: string): string {
  const usableSummary = summaryBullets.find((item) => !item.includes("未生成") && !item.includes("エラー"));
  return cleanupLabel(usableSummary || fallbackTitle);
}

function cleanupLabel(input: string): string {
  return input
    .replace(/^[-・\s]+/, "")
    .replace(/。.*$/, "")
    .replace(/[、，].*$/, "")
    .trim();
}

function kindLabel(kind: ArchiveEntry["kind"]): string {
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "url") {
    return "URL";
  }
  return "ファイル";
}

function isTextMessage(message: LineMessage): message is Extract<LineMessage, { type: "text" }> {
  return message.type === "text" && typeof message.id === "string" && typeof message.text === "string";
}

function isFileMessage(message: LineMessage): message is Extract<LineMessage, { type: "file" }> {
  return (
    message.type === "file" &&
    typeof message.id === "string" &&
    typeof message.fileName === "string"
  );
}
