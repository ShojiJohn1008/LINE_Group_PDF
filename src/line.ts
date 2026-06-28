import crypto from "node:crypto";

export function verifyLineSignature(
  body: Buffer,
  channelSecret: string,
  signature: string | undefined
): boolean {
  if (!signature) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export async function downloadLineMessageContent(
  messageId: string,
  channelAccessToken: string
): Promise<Buffer> {
  const response = await fetch(
    `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
    {
      headers: {
        Authorization: `Bearer ${channelAccessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to download LINE content: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
