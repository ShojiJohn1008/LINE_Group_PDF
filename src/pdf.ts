import pdfParse from "pdf-parse";

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer);
  return normalizeText(parsed.text);
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
