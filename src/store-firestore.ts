import { Firestore } from "@google-cloud/firestore";
import {
  ArchivedItem,
  createMemoryStore,
  TenantRecord,
  TenantStore
} from "./store.js";

// Firestore-backed tenant store for Cloud Run, where the local filesystem is
// ephemeral. On Cloud Run, credentials come from the runtime service account
// (Application Default Credentials) — no key file needed.
//
// Pilot constraint: this hydrates an in-memory cache at startup and writes
// through per document. It is correct for a SINGLE instance (run Cloud Run with
// max-instances=1). Multiple instances would not see each other's writes until
// restart; scaling past one instance needs an async, read-through TenantStore.
export async function createFirestoreTenantStore(opts: {
  encryptionKey: string;
  projectId?: string;
  tenantsCollection?: string;
  archivedCollection?: string;
}): Promise<TenantStore> {
  const db = new Firestore(opts.projectId ? { projectId: opts.projectId } : {});
  const tenantsCol = db.collection(opts.tenantsCollection || "tenants");
  const archivedCol = db.collection(opts.archivedCollection || "archived");

  const records = new Map<string, TenantRecord>();
  const archived: ArchivedItem[] = [];

  const tenantSnap = await tenantsCol.get();
  tenantSnap.forEach((doc) => {
    const data = doc.data() as TenantRecord;
    records.set(data.groupId, data);
  });
  const archivedSnap = await archivedCol.get();
  archivedSnap.forEach((doc) => archived.push(doc.data() as ArchivedItem));

  const archivedDocId = (item: ArchivedItem): string => `${item.groupId}__${item.driveFileId}`;
  const warn = (label: string) => (error: unknown) =>
    console.error(`firestore ${label} write failed`, error instanceof Error ? error.message : error);

  return createMemoryStore(opts.encryptionKey, records, archived, {
    persistTenant(record) {
      void tenantsCol.doc(record.groupId).set(record).catch(warn("tenant"));
    },
    persistArchive(item) {
      void archivedCol.doc(archivedDocId(item)).set(item).catch(warn("archive"));
    },
    persistUnsend(items) {
      for (const item of items) {
        void archivedCol.doc(archivedDocId(item)).update({ unsent: true }).catch(warn("unsend"));
      }
    }
  });
}
