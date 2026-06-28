import dotenv from "dotenv";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { google } from "googleapis";
import { getOAuthClientInfo, readJsonInput } from "./drive.js";

dotenv.config({ override: true });

const oauthClientJson = process.env.GOOGLE_OAUTH_CLIENT_JSON;
const tokenPath = process.env.GOOGLE_OAUTH_TOKEN_JSON || "secrets/google-oauth-token.json";
const port = Number(process.env.GOOGLE_OAUTH_REDIRECT_PORT || 53682);

if (!oauthClientJson) {
  throw new Error("Set GOOGLE_OAUTH_CLIENT_JSON to your OAuth client JSON file path.");
}

const clientInfo = getOAuthClientInfo(readJsonInput(oauthClientJson));
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const oauth2Client = new google.auth.OAuth2(
  clientInfo.client_id,
  clientInfo.client_secret,
  redirectUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive"]
});

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", redirectUri);
    if (requestUrl.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Missing authorization code.");
    }

    const tokenResponse = await oauth2Client.getToken(code);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokenResponse.tokens, null, 2));

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Google Drive authorization saved. You can close this tab.");
    console.log(`google_oauth_token saved ${tokenPath}`);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : String(error));
    console.error(error);
  } finally {
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Open this URL in your browser:");
  console.log(authUrl);
});
