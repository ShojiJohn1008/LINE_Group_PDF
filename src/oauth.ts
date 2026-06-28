import crypto from "node:crypto";
import { google } from "googleapis";
import { AppConfig, GOOGLE_DRIVE_SCOPE, redirectUri } from "./config.js";
import { getOAuthClientInfo, readJsonInput } from "./drive.js";

const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Signs `{ groupId, exp }` with HMAC-SHA256 so the OAuth callback can trust the
// groupId that round-trips through the browser without a server-side session.
export function signState(groupId: string, secret: string): string {
  const payload = base64url(JSON.stringify({ g: groupId, e: Date.now() + STATE_TTL_MS }));
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifyState(token: string, secret: string): { groupId: string } | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }
  const expected = hmac(payload, secret);
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      g?: string;
      e?: number;
    };
    if (!decoded.g || !decoded.e || decoded.e < Date.now()) {
      return null;
    }
    return { groupId: decoded.g };
  } catch {
    return null;
  }
}

// The link the bot posts into the group. Tapping it starts the Google consent.
export function buildConnectUrl(config: AppConfig, groupId: string): string {
  const state = signState(groupId, config.stateSecret);
  return `${config.publicBaseUrl}/connect?state=${encodeURIComponent(state)}`;
}

export function createOAuthClient(config: AppConfig) {
  const clientInfo = getOAuthClientInfo(readJsonInput(config.googleOAuthClientJson));
  return new google.auth.OAuth2(clientInfo.client_id, clientInfo.client_secret, redirectUri(config));
}

export function buildGoogleAuthUrl(config: AppConfig, state: string): string {
  return createOAuthClient(config).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GOOGLE_DRIVE_SCOPE],
    state
  });
}

// Builds an OAuth2 client primed with a tenant's refresh token. googleapis
// auto-refreshes the access token from it on each Drive call.
export function authedClient(config: AppConfig, refreshToken: string) {
  const client = createOAuthClient(config);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export async function exchangeCode(config: AppConfig, code: string): Promise<string> {
  const client = createOAuthClient(config);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Ensure the consent used prompt=consent and access_type=offline."
    );
  }
  return tokens.refresh_token;
}

function hmac(input: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(input).digest("base64url");
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}
