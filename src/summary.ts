import OpenAI from "openai";
import {
  Category,
  CATEGORIES,
  normalizeCategory,
  normalizeResourceType,
  RESOURCE_TYPES,
  ResourceType,
  UNCATEGORIZED,
  OTHER_TYPE
} from "./categories.js";

export type SummaryResult = {
  bullets: string[];
  tags: string[];
  category: Category;
  type: ResourceType;
};

export async function summarizeContent(params: {
  apiKey?: string;
  model: string;
  title: string;
  sourceKind: "pdf" | "url" | "file";
  text: string;
}): Promise<SummaryResult> {
  const clippedText = params.text.slice(0, 24_000).trim();

  if (!params.apiKey) {
    return {
      bullets: [
        "OPENAI_API_KEY が未設定のため、要約は未生成です。",
        clippedText ? `抽出本文の冒頭: ${clippedText.slice(0, 160)}` : "本文を抽出できませんでした。"
      ],
      tags: [],
      category: UNCATEGORIZED,
      type: OTHER_TYPE
    };
  }

  if (!clippedText) {
    return {
      bullets: ["本文を抽出できなかったため、自動要約できませんでした。"],
      tags: [],
      category: UNCATEGORIZED,
      type: OTHER_TYPE
    };
  }

  let response: { output_text: string };
  try {
    const client = new OpenAI({ apiKey: params.apiKey });
    response = await client.responses.create({
      model: params.model,
      input: [
        {
          role: "system",
          content:
            "あなたはLINEグループで共有された資料を索引化する助手です。誤解を招く断定を避け、読むべきか判断できる短い日本語要約を作ってください。"
        },
        {
          role: "user",
          content: [
            `種類: ${params.sourceKind}`,
            `タイトル: ${params.title}`,
            "",
            "以下の本文から、JSONだけを返してください。",
            '{"bullets":["3から5個の要点"],"tags":["日本語タグを最大5個"],"category":"主題カテゴリを1つ","type":"資料タイプを1つ"}',
            "",
            `category は次から必ず1つだけ選ぶ: ${CATEGORIES.join(" / ")}`,
            `type は次から必ず1つだけ選ぶ: ${RESOURCE_TYPES.join(" / ")}`,
            "迷ったら category は「総合診療・診断推論（症候）」、判定不能なら「その他・未分類」。",
            "",
            clippedText
          ].join("\n")
        }
      ],
      text: {
        format: {
          type: "json_object"
        }
      }
    });
  } catch (error) {
    const summaryError = formatSummaryError(error);
    console.error(summaryError);
    return {
      bullets: [
        "OpenAI APIエラーのため、要約は未生成です。",
        "元資料の保存と索引化は継続しました。"
      ],
      tags: [],
      category: UNCATEGORIZED,
      type: OTHER_TYPE
    };
  }

  const parsed = JSON.parse(response.output_text) as Partial<SummaryResult>;
  return {
    bullets: normalizeStringArray(parsed.bullets).slice(0, 5),
    tags: normalizeStringArray(parsed.tags).slice(0, 5),
    category: normalizeCategory(parsed.category),
    type: normalizeResourceType(parsed.type)
  };
}

function formatSummaryError(error: unknown): string {
  const maybeError = error as {
    status?: number;
    code?: string;
    type?: string;
    message?: string;
  };

  return [
    "summary_failed",
    `status=${maybeError.status ?? "unknown"}`,
    maybeError.code ? `code=${maybeError.code}` : undefined,
    maybeError.type ? `type=${maybeError.type}` : undefined,
    maybeError.message ? `message=${redactApiKey(maybeError.message)}` : undefined
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");
}

function redactApiKey(input: string): string {
  return input.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}
