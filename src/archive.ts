import path from "node:path";
import { AppConfig } from "./config.js";
import { appendToIndex, createDriveClient, ensureFolder, uploadBuffer } from "./drive.js";
import { downloadLineMessageContent } from "./line.js";
import { extractPdfText } from "./pdf.js";
import { summarizeContent } from "./summary.js";
import { ArchiveEntry, LineMessage, LineWebhookEvent } from "./types.js";
import { extractUrls, readWebPage } from "./web.js";

export async function archiveEvent(event: LineWebhookEvent, config: AppConfig): Promise<void> {
  if (event.type !== "message" || !event.message) {
    return;
  }

  const drive = createDriveClient(
    {
      serviceAccountJson: config.googleServiceAccountJson,
      oauthClientJson: config.googleOAuthClientJson,
      oauthTokenJson: config.googleOAuthTokenJson
    },
    config.googleDriveFolderId,
    config.googleDriveIndexFileId
  );

  if (isFileMessage(event.message)) {
    const content = await downloadLineMessageContent(event.message.id, config.lineChannelAccessToken);
    const postedAt = new Date(event.timestamp);
    const mimeType = guessMimeType(event.message.fileName);
    const text = mimeType === "application/pdf" ? await safeExtractPdfText(content) : "";
    const summary = await summarizeContent({
      apiKey: config.openAiApiKey,
      model: config.openAiModel,
      title: event.message.fileName,
      sourceKind: mimeType === "application/pdf" ? "pdf" : "file",
      text
    });
    const filesRootFolderId = await ensureFolder(drive, "files");
    const filesMonthFolderId = await ensureFolder(drive, formatYearMonth(postedAt), filesRootFolderId);
    const fileName = buildStoredFileName({
      date: postedAt,
      kind: mimeType === "application/pdf" ? "PDF" : "FILE",
      label: bestContentLabel(summary.bullets, event.message.fileName),
      extension: path.extname(event.message.fileName) || ".bin"
    });
    const uploaded = await uploadBuffer(drive, filesMonthFolderId, fileName, mimeType, content);

    await appendToIndex(
      drive,
      renderArchiveEntry({
        kind: mimeType === "application/pdf" ? "pdf" : "file",
        postedAt,
        senderId: event.source?.userId || "unknown",
        groupId: event.source?.groupId || event.source?.roomId || "unknown",
        title: event.message.fileName,
        driveUrl: uploaded.webViewLink,
        driveFileId: uploaded.id,
        summary: summary.bullets,
        tags: summary.tags,
        notes: text ? undefined : ["PDF本文を抽出できない場合は、スキャンPDFまたは画像主体の資料の可能性があります。"]
      })
    );
  }

  if (isTextMessage(event.message)) {
    const urls = extractUrls(event.message.text);
    for (const url of urls) {
      await archiveUrl(event, config, drive, url);
    }
  }
}

async function archiveUrl(
  event: LineWebhookEvent,
  config: AppConfig,
  drive: ReturnType<typeof createDriveClient>,
  url: string
): Promise<void> {
  const postedAt = new Date(event.timestamp);
  const page = await readWebPage(url);
  const summary = await summarizeContent({
    apiKey: config.openAiApiKey,
    model: config.openAiModel,
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
      groupId: event.source?.groupId || event.source?.roomId || "unknown",
      title: page.title,
      originalUrl: url,
      driveUrl: uploaded.webViewLink,
      driveFileId: uploaded.id,
      summary: summary.bullets,
      tags: summary.tags
    })
  );
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

function formatDateForFile(date: Date): string {
  const parts = getJapanDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatYearMonth(date: Date): string {
  const parts = getJapanDateParts(date);
  return `${parts.year}-${parts.month}`;
}

function getJapanDateParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return {
    year: parts.find((part) => part.type === "year")?.value || "0000",
    month: parts.find((part) => part.type === "month")?.value || "00",
    day: parts.find((part) => part.type === "day")?.value || "00"
  };
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
