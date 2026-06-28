// Outbound LINE Messaging API: the bot replies to / pushes messages into a
// group (connect link, completion notice, quota notice). Inbound signature
// verification and content download live in line.ts.

export async function replyText(
  replyToken: string,
  text: string,
  channelAccessToken: string
): Promise<void> {
  await callLine(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages: [{ type: "text", text }] },
    channelAccessToken
  );
}

export async function pushText(
  to: string,
  text: string,
  channelAccessToken: string
): Promise<void> {
  await callLine(
    "https://api.line.me/v2/bot/message/push",
    { to, messages: [{ type: "text", text }] },
    channelAccessToken
  );
}

async function callLine(url: string, body: unknown, channelAccessToken: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LINE send failed: ${response.status} ${response.statusText} ${detail}`.trim());
  }
}
