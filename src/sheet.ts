import { google } from "googleapis";
import type { OAuthClient } from "./drive.js";

// A Google Sheets "dashboard" index alongside references.md: one row per item,
// so users get native sort / filter / search (great on the mobile Sheets app).
// The Sheets API honors the drive.file scope for spreadsheets the app created,
// so no extra OAuth scope is needed — but the Google Cloud project must have the
// Sheets API enabled. All Sheets calls are best-effort: a disabled API or
// transient error must never block archiving (the artifact is already saved).

export const DASHBOARD_SHEET_NAME = "資料ダッシュボード";
const HEADER = ["日付", "種別", "タイトル", "タグ", "要約", "保存先", "元URL", "カテゴリ", "タイプ"];

// Create (or reuse) the dashboard spreadsheet in the archive folder and return
// its id. The file itself is created via the Drive API (always works); the
// header/format pass via the Sheets API is best-effort.
export async function provisionDashboard(auth: OAuthClient, rootFolderId: string): Promise<string> {
  const drive = google.drive({ version: "v3", auth });

  const existing = await drive.files.list({
    q: [
      `'${rootFolderId}' in parents`,
      `name = '${DASHBOARD_SHEET_NAME}'`,
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
      "trashed = false"
    ].join(" and "),
    fields: "files(id)",
    spaces: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  const found = existing.data.files?.[0]?.id;
  if (found) {
    return found;
  }

  const created = await drive.files.create({
    requestBody: {
      name: DASHBOARD_SHEET_NAME,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [rootFolderId]
    },
    fields: "id",
    supportsAllDrives: true
  });
  const sheetId = created.data.id;
  if (!sheetId) {
    throw new Error("Failed to create dashboard spreadsheet");
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "A1",
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] }
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount"
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error(
      "dashboard header setup skipped (is the Sheets API enabled?)",
      error instanceof Error ? error.message : error
    );
  }

  return sheetId;
}

export async function appendDashboardRow(
  auth: OAuthClient,
  spreadsheetId: string,
  row: string[]
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "A1",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] }
  });
}
