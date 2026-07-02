import path from "node:path";
import { AppConfig } from "./config.js";
import {
  annotateUnsent,
  appendToIndex,
  createDriveClient,
  DriveClient,
  ensureFolder,
  renameFile,
  uploadBuffer
} from "./drive.js";
import { downloadLineMessageContent } from "./line.js";
import { pushText } from "./line-push.js";
import { authedClient } from "./oauth.js";
import { extractPdfText } from "./pdf.js";
import { appendDashboardRow } from "./sheet.js";
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
      // Sharing a PDF from Safari/apps sends the direct file URL *and* the file
      // itself as separate messages. Skip the URL: the file message archives the
      // same document properly (with PDF text extraction), avoiding a duplicate.
      if (isDirectFileUrl(url)) {
        console.log("skip direct-file url (archived via file message)", { groupId, url });
        continue;
      }
      await archiveUrl(event, deps, tenant, groupId, drive, url);
    }
  }
}

// URLs whose path points straight at a downloadable document. LINE's share sheet
// attaches the file alongside the link, so we let the file message handle it.
const DIRECT_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx"
]);

function isDirectFileUrl(url: string): boolean {
  try {
    return DIRECT_FILE_EXTENSIONS.has(path.extname(new URL(url).pathname).toLowerCase());
  } catch {
    return false;
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
  const isPdf = mimeType === "application/pdf";
  const extension = path.extname(message.fileName) || ".bin";

  // Save-first: upload under a provisional name so the artifact lands in Drive
  // immediately; the (slow) summary runs in parallel and refines things after.
  const summaryPromise = (async () => {
    const text = isPdf ? await safeExtractPdfText(content) : "";
    const summary = await summarizeContent({
      apiKey: deps.config.openAiApiKey,
      model: deps.config.openAiModel,
      title: message.fileName,
      sourceKind: isPdf ? "pdf" : "file",
      text
    });
    return { text, summary };
  })();

  const provisionalName = buildStoredFileName({
    date: postedAt,
    kind: isPdf ? "PDF" : "FILE",
    label: bestContentLabel([], message.fileName),
    extension
  });
  const uploaded = await uploadToMonthFolder(
    drive,
    groupId,
    "files",
    postedAt,
    provisionalName,
    mimeType,
    content
  );
  deps.store.incrementUsage(groupId, postedAt);

  const { text, summary } = await summaryPromise;

  // Once the summary is in, prefer its first bullet as the file's content label.
  const finalName = buildStoredFileName({
    date: postedAt,
    kind: isPdf ? "PDF" : "FILE",
    label: bestContentLabel(summary.bullets, message.fileName),
    extension
  });
  if (finalName !== provisionalName) {
    await renameFile(drive, uploaded.id, finalName).catch((error) =>
      console.error("rename after summary failed", error instanceof Error ? error.message : error)
    );
  }

  await appendToIndex(
    drive,
    renderArchiveEntry({
      kind: isPdf ? "pdf" : "file",
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

  deps.store.recordArchive(groupId, {
    messageId: message.id,
    dedupKey,
    driveFileId: uploaded.id,
    title: message.fileName,
    kind: isPdf ? "pdf" : "file",
    postedAt: postedAt.toISOString(),
    tags: summary.tags,
    summary: summary.bullets,
    driveUrl: uploaded.webViewLink ?? "",
    originalUrl: ""
  });
  await appendDashboard(deps, tenant, [
    formatDateForFile(postedAt),
    isPdf ? "PDF" : "ファイル",
    message.fileName,
    formatTagsInline(summary.tags),
    summary.bullets.join(" / "),
    uploaded.webViewLink ?? "",
    ""
  ]);
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

  // Save-first: snapshot goes to Drive under a provisional name; the summary
  // runs in parallel and the name/index/dashboard follow once it lands.
  const summaryPromise = summarizeContent({
    apiKey: deps.config.openAiApiKey,
    model: deps.config.openAiModel,
    title: page.title,
    sourceKind: "url",
    text: page.text
  });

  const provisionalName = buildStoredFileName({
    date: postedAt,
    kind: "URL",
    label: bestContentLabel([], page.title),
    extension: ".md"
  });
  const uploaded = await uploadToMonthFolder(
    drive,
    groupId,
    "web",
    postedAt,
    provisionalName,
    "text/markdown",
    Buffer.from(page.markdownSnapshot, "utf8")
  );
  deps.store.incrementUsage(groupId, postedAt);

  const summary = await summaryPromise;

  const finalName = buildStoredFileName({
    date: postedAt,
    kind: "URL",
    label: bestContentLabel(summary.bullets, page.title),
    extension: ".md"
  });
  if (finalName !== provisionalName) {
    await renameFile(drive, uploaded.id, finalName).catch((error) =>
      console.error("rename after summary failed", error instanceof Error ? error.message : error)
    );
  }

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

  deps.store.recordArchive(groupId, {
    messageId: event.message?.id ?? "unknown",
    dedupKey,
    driveFileId: uploaded.id,
    title: page.title,
    kind: "url",
    postedAt: postedAt.toISOString(),
    tags: summary.tags,
    summary: summary.bullets,
    driveUrl: uploaded.webViewLink ?? "",
    originalUrl: url
  });
  await appendDashboard(deps, tenant, [
    formatDateForFile(postedAt),
    "URL",
    page.title,
    formatTagsInline(summary.tags),
    summary.bullets.join(" / "),
    uploaded.webViewLink ?? "",
    url
  ]);
}

// Best-effort dashboard row. A missing sheet (tenant connected before the
// feature) or a transient Sheets error must never undo the archive.
async function appendDashboard(
  deps: ArchiveDeps,
  tenant: TenantRecord,
  row: string[]
): Promise<void> {
  if (!tenant.sheetId) {
    return;
  }
  const refreshToken = deps.store.getRefreshToken(tenant.groupId);
  if (!refreshToken) {
    return;
  }
  try {
    await appendDashboardRow(authedClient(deps.config, refreshToken), tenant.sheetId, row);
  } catch (error) {
    console.error("dashboard row append failed", error instanceof Error ? error.message : error);
  }
}

function formatTagsInline(tags: string[]): string {
  return tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
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

// Free tier: stop archiving past the monthly limit. Notify on every blocked
// item so users understand why a posted resource was not archived.
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
  await pushText(
    groupId,
    `今月の無料枠（${deps.config.freeMonthlyLimit}件）を超えているため、この資料は保存されませんでした。来月になると自動的にリセットされます。`,
    deps.config.lineChannelAccessToken
  ).catch(() => undefined);
  return false;
}

// Folder ids are stable, so cache them per tenant/month and skip the two Drive
// list calls per item. If a cached id has gone stale (folder trashed by the
// user), invalidate and re-resolve once before giving up.
const folderIdCache = new Map<string, string>();

async function uploadToMonthFolder(
  drive: DriveClient,
  groupId: string,
  top: "files" | "web",
  postedAt: Date,
  name: string,
  mimeType: string,
  body: Buffer
): Promise<{ id: string; webViewLink?: string }> {
  const month = formatYearMonth(postedAt);
  const cacheKey = `${groupId}:${drive.rootFolderId}:${top}:${month}`;

  const resolveFolder = async (): Promise<string> => {
    const topId = await ensureFolder(drive, top);
    const monthId = await ensureFolder(drive, month, topId);
    folderIdCache.set(cacheKey, monthId);
    return monthId;
  };

  const cached = folderIdCache.get(cacheKey);
  if (!cached) {
    return uploadBuffer(drive, await resolveFolder(), name, mimeType, body);
  }
  try {
    return await uploadBuffer(drive, cached, name, mimeType, body);
  } catch (error) {
    console.error("upload with cached folder failed; re-resolving", {
      cacheKey,
      error: error instanceof Error ? error.message : error
    });
    folderIdCache.delete(cacheKey);
    return uploadBuffer(drive, await resolveFolder(), name, mimeType, body);
  }
}

function tenantDrive(config: AppConfig, store: TenantStore, tenant: TenantRecord): DriveClient {
  const refreshToken = store.getRefreshToken(tenant.groupId);
  if (!refreshToken) {
    throw new Error(`Missing refresh token for tenant ${tenant.groupId}`);
  }
  const auth = authedClient(config, refreshToken);
  return createDriveClient(auth, tenant.rootFolderId, tenant.indexFileId);
}

// One scannable card per item: icon + title heading, then a single compact meta
// line (date ・ tags ・ links), then the summary. The Drive file id is kept as a
// hidden HTML comment (invisible when rendered) so unsend can still locate the
// entry without cluttering the view.
function renderArchiveEntry(entry: ArchiveEntry): string {
  const date = formatDateForFile(entry.postedAt);
  const tags = entry.tags.length
    ? entry.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")
    : "タグなし";
  const links = [
    entry.driveUrl ? `[📁保存先](${entry.driveUrl})` : undefined,
    entry.originalUrl ? `[🔗元URL](${entry.originalUrl})` : undefined
  ].filter((part): part is string => part !== undefined);
  const meta = [date, tags, ...links].join(" ・ ");
  const summaryLines = entry.summary.length
    ? entry.summary.map((item) => `- ${item}`).join("\n")
    : "- 要約は未生成です。";
  const notes = entry.notes?.length
    ? entry.notes.map((note) => `> ⚠️ ${note}`).join("\n")
    : undefined;

  return [
    `### ${kindIcon(entry.kind)} ${entry.title}`,
    meta,
    "",
    summaryLines,
    notes,
    `<!-- id:${entry.driveFileId ?? ""} -->`
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

function kindIcon(kind: ArchiveEntry["kind"]): string {
  if (kind === "pdf") {
    return "📄";
  }
  if (kind === "url") {
    return "🔗";
  }
  return "📎";
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
