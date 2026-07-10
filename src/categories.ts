// Controlled vocabulary for the knowledge base — the single source of truth for
// classification, Drive folders, and dashboard facets. Human-readable docs in
// docs/CATEGORIES.md must be kept in sync. Renaming a value is a breaking change
// (existing stored items / Drive folders use these exact strings).

// 軸1：主題カテゴリ（1資料に1つ）
export const CATEGORIES = [
  "感染症・抗菌薬",
  "循環器",
  "呼吸器",
  "消化器・肝胆膵",
  "腎・泌尿器・電解質",
  "内分泌・代謝（糖尿病）",
  "血液・腫瘍",
  "膠原病・リウマチ・アレルギー",
  "神経・脳卒中",
  "精神・心身・依存",
  "救急・集中治療・中毒",
  "総合診療・診断推論（症候）",
  "老年・緩和・在宅",
  "予防・健診・ワクチン・公衆衛生",
  "その他・未分類"
] as const;

export type Category = (typeof CATEGORIES)[number];
export const UNCATEGORIZED: Category = "その他・未分類";

// 軸2：資料タイプ（1資料に1つ）
export const RESOURCE_TYPES = [
  "ガイドライン",
  "原著論文（抄読会）",
  "総説・レビュー",
  "マニュアル・手技・プロトコル",
  "勉強会・スライド",
  "その他"
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export const OTHER_TYPE: ResourceType = "その他";

// Coerce free-form model output to a known value; anything unrecognized falls
// back to the catch-all so downstream code always has a valid category/type.
export function normalizeCategory(input: unknown): Category {
  return (CATEGORIES as readonly string[]).includes(input as string)
    ? (input as Category)
    : UNCATEGORIZED;
}

export function normalizeResourceType(input: unknown): ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(input as string)
    ? (input as ResourceType)
    : OTHER_TYPE;
}

// Safe Drive folder name for a category (no path separators, trimmed length).
export function categoryFolderName(category: Category): string {
  return category.replace(/[\\/]/g, "_");
}
