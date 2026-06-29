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

// One archived artifact. A text message with several URLs produces several of
// these, all sharing the same messageId (used to undo on unsend).
export type ArchivedItem = {
  groupId: string;
  messageId: string;
  dedupKey: string;
  driveFileId: string;
  title: string;
  kind: string;
  unsent: boolean;
  createdAt: string;
};

export type ArchivedInput = {
  messageId: string;
  dedupKey: string;
  driveFileId: string;
  title: string;
  kind: string;
};

export type TenantStore = {
  get(groupId: string): TenantRecord | undefined;
  isConnected(groupId: string): boolean;
  upsertConnection(groupId: string, connection: TenantConnection): void;
  getRefreshToken(groupId: string): string | undefined;
  getUsage(groupId: string, when: Date): number;
  incrementUsage(groupId: string, when: Date): number;
  // Dedup: has this (groupId, dedupKey) already been archived (and not unsent)?
  isArchived(groupId: string, dedupKey: string): boolean;
  recordArchive(groupId: string, item: ArchivedInput): void;
  // Unsend: items archived from a given LINE message.
  findByMessage(groupId: string, messageId: string): ArchivedItem[];
  markUnsent(groupId: string, messageId: string): void;
};

type PersistShape = {
  tenants: TenantRecord[];
  archived: ArchivedItem[];
};

export function createTenantStore(filePath: string, encryptionKey: string): TenantStore {
  const key = normalizeKey(encryptionKey);
  const records = new Map<string, TenantRecord>();
  const archived: ArchivedItem[] = [];

  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistShape | TenantRecord[];
    // Backward compat: the original format was a bare TenantRecord[].
    const tenants = Array.isArray(parsed) ? parsed : parsed.tenants;
    for (const record of tenants) {
      records.set(record.groupId, record);
    }
    if (!Array.isArray(parsed) && parsed.archived) {
      archived.push(...parsed.archived);
    }
  }

  function persist(): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const shape: PersistShape = { tenants: Array.from(records.values()), archived };
    fs.writeFileSync(filePath, JSON.stringify(shape, null, 2));
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
    },
    isArchived(groupId, dedupKey) {
      return archived.some(
        (item) => item.groupId === groupId && item.dedupKey === dedupKey && !item.unsent
      );
    },
    recordArchive(groupId, item) {
      archived.push({
        groupId,
        messageId: item.messageId,
        dedupKey: item.dedupKey,
        driveFileId: item.driveFileId,
        title: item.title,
        kind: item.kind,
        unsent: false,
        createdAt: new Date().toISOString()
      });
      persist();
    },
    findByMessage(groupId, messageId) {
      return archived.filter((item) => item.groupId === groupId && item.messageId === messageId);
    },
    markUnsent(groupId, messageId) {
      let changed = false;
      for (const item of archived) {
        if (item.groupId === groupId && item.messageId === messageId && !item.unsent) {
          item.unsent = true;
          changed = true;
        }
      }
      if (changed) {
        persist();
      }
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

// Shared with the Firestore backend so refresh tokens are encrypted there too.
export { encrypt as encryptSecret, decrypt as decryptSecret, normalizeKey as normalizeEncryptionKey };
