import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatYearMonth } from "./time.js";

// Persisted tenant record. The Google refresh token is the only per-tenant
// secret and is stored encrypted (AES-256-GCM).
export type TenantRecord = {
  groupId: string;
  refreshTokenEnc: string;
  rootFolderId: string;
  indexFileId: string;
  connectedAt: string;
  usageMonth: string;
  usageCount: number;
};

export type TenantConnection = {
  refreshToken: string;
  rootFolderId: string;
  indexFileId: string;
};

export type TenantStore = {
  get(groupId: string): TenantRecord | undefined;
  isConnected(groupId: string): boolean;
  upsertConnection(groupId: string, connection: TenantConnection): void;
  getRefreshToken(groupId: string): string | undefined;
  // Returns the usage count for the given date's JST month, resetting the
  // counter when the month rolls over. Does not mutate.
  getUsage(groupId: string, when: Date): number;
  // Increments and persists the usage counter for the date's JST month.
  // Returns the new count.
  incrementUsage(groupId: string, when: Date): number;
};

export function createTenantStore(filePath: string, encryptionKey: string): TenantStore {
  const key = normalizeKey(encryptionKey);
  const records = new Map<string, TenantRecord>();

  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as TenantRecord[];
    for (const record of parsed) {
      records.set(record.groupId, record);
    }
  }

  function persist(): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(Array.from(records.values()), null, 2));
  }

  function reconcileMonth(record: TenantRecord, when: Date): TenantRecord {
    const month = formatYearMonth(when);
    if (record.usageMonth !== month) {
      record.usageMonth = month;
      record.usageCount = 0;
    }
    return record;
  }

  return {
    get(groupId) {
      return records.get(groupId);
    },
    isConnected(groupId) {
      return records.has(groupId);
    },
    upsertConnection(groupId, connection) {
      const existing = records.get(groupId);
      const record: TenantRecord = {
        groupId,
        refreshTokenEnc: encrypt(connection.refreshToken, key),
        rootFolderId: connection.rootFolderId,
        indexFileId: connection.indexFileId,
        connectedAt: existing?.connectedAt || new Date().toISOString(),
        usageMonth: existing?.usageMonth || formatYearMonth(new Date()),
        usageCount: existing?.usageCount || 0
      };
      records.set(groupId, record);
      persist();
    },
    getRefreshToken(groupId) {
      const record = records.get(groupId);
      return record ? decrypt(record.refreshTokenEnc, key) : undefined;
    },
    getUsage(groupId, when) {
      const record = records.get(groupId);
      if (!record) {
        return 0;
      }
      const month = formatYearMonth(when);
      return record.usageMonth === month ? record.usageCount : 0;
    },
    incrementUsage(groupId, when) {
      const record = records.get(groupId);
      if (!record) {
        return 0;
      }
      reconcileMonth(record, when);
      record.usageCount += 1;
      persist();
      return record.usageCount;
    }
  };
}

function normalizeKey(input: string): Buffer {
  const trimmed = input.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (buffer.length !== 32) {
    throw new Error(
      "TENANT_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64). " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  return buffer;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decrypt(payload: string, key: Buffer): string {
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
