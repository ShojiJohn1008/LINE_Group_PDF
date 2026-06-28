import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export type WebPageContent = {
  title: string;
  text: string;
  markdownSnapshot: string;
};

export async function readWebPage(url: string): Promise<WebPageContent> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "LINE-Group-PDF-Archive/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const documentTitle = dom.window.document.querySelector("title")?.textContent?.trim();
  const title = article?.title?.trim() || documentTitle || url;
  const text = normalizeText(article?.textContent || dom.window.document.body.textContent || "");

  return {
    title,
    text,
    markdownSnapshot: [
      `# ${title}`,
      "",
      `- URL: ${url}`,
      `- Archived at: ${new Date().toISOString()}`,
      "",
      text || "_本文を抽出できませんでした。_"
    ].join("\n")
  };
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'）)】]+/g) || [];
  return Array.from(new Set(matches));
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
