import { db, getKV, setKV, type Collection, type Comic, type Progress, type ReadingSession } from '../db';
import * as drive from './drive';
import { clearDirty, isDirty, markDirty, onDirty } from './syncState';
import { getPrefs, getPrefsUpdatedAt, setPrefs, type Prefs } from './prefs';
import { collectionMembers } from './library';

/**
 * Everything except the comic files themselves lives in one JSON file in Drive's hidden
 * app-data folder. Each record carries updatedAt; merges are last-writer-wins per record,
 * sessions are append-only. Comic files go to a visible Drive folder when a collection
 * has Drive sync on (or you upload one manually).
 */
interface SyncDoc {
  version: 1;
  writtenAt: number;
  comics: Record<string, Omit<Comic, 'cover' | 'hasFile'>>;
  progress: Record<string, Progress>;
  collections: Record<string, Collection>;
  sessions: ReadingSession[];
  prefs?: { value: Prefs; updatedAt: number };
}

export type SyncStatus =
  | { state: 'off' }
  | { state: 'idle'; lastSync?: number }
  | { state: 'syncing' }
  | { state: 'error'; message: string; needsSignIn?: boolean; lastSync?: number };

type Transfer = { id: string; title: string; kind: 'upload' | 'download'; progress: number; error?: string };

const listeners = new Set<() => void>();
let status: SyncStatus = drive.isConnected() ? { state: 'idle' } : { state: 'off' };
let transfers: Transfer[] = [];
const emit = () => listeners.forEach((l) => l());

export function subscribeSync(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const getSyncStatus = () => status;
export const getTransfers = () => transfers;
function setStatus(s: SyncStatus) {
  status = s;
  emit();
}
function setTransfer(t: Transfer | { id: string; remove: true }) {
  transfers = transfers.filter((x) => x.id !== t.id);
  if (!('remove' in t)) transfers = [...transfers, t];
  emit();
}

const newer = (a?: { updatedAt: number }, b?: { updatedAt: number }) => !!a && (!b || a.updatedAt > b.updatedAt);

async function buildDoc(): Promise<SyncDoc> {
  const prefsUpdatedAt = getPrefsUpdatedAt();
  const [comics, progress, collections, sessions] = await Promise.all([
    db.comics.toArray(),
    db.progress.toArray(),
    db.collections.toArray(),
    db.sessions.orderBy('startedAt').reverse().limit(3000).toArray(),
  ]);
  return {
    version: 1,
    writtenAt: Date.now(),
    comics: Object.fromEntries(comics.map(({ cover: _c, hasFile: _h, ...c }) => [c.id, c])),
    progress: Object.fromEntries(progress.map((p) => [p.comicId, p])),
    collections: Object.fromEntries(collections.map((c) => [c.id, c])),
    sessions,
    prefs: { value: getPrefs(), updatedAt: prefsUpdatedAt },
  };
}

/** Apply remote records that are newer than ours. Returns true if local data changed. */
async function mergeRemote(remote: SyncDoc): Promise<boolean> {
  let changed = false;
  await db.transaction('rw', [db.comics, db.progress, db.collections, db.sessions, db.files], async () => {
    for (const rc of Object.values(remote.comics ?? {})) {
      const local = await db.comics.get(rc.id);
      if (!newer(rc, local)) continue;
      changed = true;
      if (rc.deleted && local?.hasFile) await db.files.delete(rc.id);
      await db.comics.put({ ...rc, cover: rc.deleted ? undefined : local?.cover, hasFile: rc.deleted ? 0 : local?.hasFile ?? 0 });
    }
    for (const rp of Object.values(remote.progress ?? {})) {
      if (newer(rp, await db.progress.get(rp.comicId))) {
        await db.progress.put(rp);
        changed = true;
      }
    }
    for (const rcol of Object.values(remote.collections ?? {})) {
      if (newer(rcol, await db.collections.get(rcol.id))) {
        await db.collections.put(rcol);
        changed = true;
      }
    }
    const have = new Set(await db.sessions.toCollection().primaryKeys());
    const missing = (remote.sessions ?? []).filter((s) => !have.has(s.id));
    if (missing.length) {
      await db.sessions.bulkPut(missing);
      changed = true;
    }
  });
  if (remote.prefs && remote.prefs.updatedAt > getPrefsUpdatedAt()) {
    setPrefs(remote.prefs.value, remote.prefs.updatedAt);
    changed = true;
  }
  return changed;
}

let running: Promise<void> | null = null;

export function syncNow(): Promise<void> {
  if (!drive.isConnected()) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    setStatus({ state: 'syncing' });
    try {
      const file = await drive.findSyncFile();
      let remote: SyncDoc | null = null;
      if (file) remote = (await drive.readSyncFile(file.id)) as SyncDoc;
      if (remote) await mergeRemote(remote);
      const local = await buildDoc();
      if (!remote || isDirty() || docDiffers(local, remote)) {
        await drive.writeSyncFile(file?.id ?? null, local);
      }
      clearDirty();
      const now = Date.now();
      await setKV('sync.last', now);
      setStatus({ state: 'idle', lastSync: now });
      void processDriveQueue();
    } catch (e) {
      const needsSignIn = e instanceof drive.NeedsSignIn;
      setStatus({ state: 'error', message: (e as Error).message, needsSignIn, lastSync: await getKV<number>('sync.last', 0) });
    } finally {
      running = null;
    }
  })();
  return running;
}

function docDiffers(a: SyncDoc, b: SyncDoc) {
  const strip = (d: SyncDoc) => JSON.stringify({ ...d, writtenAt: 0 });
  return strip(a) !== strip(b);
}

/** Upload comics that belong to Drive-synced collections and aren't in Drive yet. */
let queueRunning = false;
export async function processDriveQueue() {
  if (queueRunning || !drive.isConnected()) return;
  queueRunning = true;
  try {
    const cols = (await db.collections.toArray()).filter((c) => c.driveSync && !c.deleted);
    if (!cols.length) return;
    const comics = await db.comics.filter((c) => !c.deleted).toArray();
    const progress = new Map((await db.progress.toArray()).map((p) => [p.comicId, p]));
    const pending = new Map<string, Comic>();
    for (const col of cols) {
      for (const c of collectionMembers(col, comics, progress)) if (c.hasFile && !c.driveFileId) pending.set(c.id, c);
    }
    for (const c of pending.values()) {
      await uploadToDrive(c.id).catch(() => {}); // failures show in the transfer list; keep going
    }
  } finally {
    queueRunning = false;
  }
}

export async function uploadToDrive(comicId: string) {
  const comic = await db.comics.get(comicId);
  const file = await db.files.get(comicId);
  if (!comic || !file || comic.driveFileId) return;
  setTransfer({ id: comicId, title: comic.title, kind: 'upload', progress: 0 });
  try {
    const driveFileId = await drive.uploadComic(file.blob, comic.fileName, (p) =>
      setTransfer({ id: comicId, title: comic.title, kind: 'upload', progress: p }),
    );
    await db.comics.update(comicId, { driveFileId, updatedAt: Date.now() });
    setTransfer({ id: comicId, remove: true });
    markDirty();
  } catch (e) {
    setTransfer({ id: comicId, title: comic.title, kind: 'upload', progress: 0, error: (e as Error).message });
    throw e;
  }
}

export async function downloadFromDrive(comicId: string) {
  const comic = await db.comics.get(comicId);
  if (!comic?.driveFileId) throw new Error('This comic is not in Google Drive.');
  setTransfer({ id: comicId, title: comic.title, kind: 'download', progress: 0 });
  try {
    const blob = await drive.downloadComic(comic.driveFileId, (p) =>
      setTransfer({ id: comicId, title: comic.title, kind: 'download', progress: p }),
    );
    const { importFile } = await import('./importer');
    await importFile(blob, comic.fileName, { driveFileId: comic.driveFileId });
    setTransfer({ id: comicId, remove: true });
  } catch (e) {
    setTransfer({ id: comicId, title: comic.title, kind: 'download', progress: 0, error: (e as Error).message });
    throw e;
  }
}

export function dismissTransfer(id: string) {
  setTransfer({ id, remove: true });
}

/** Wire up automatic syncing: on launch, when returning to the app, and shortly after changes. */
export function startAutoSync() {
  let timer: number | undefined;
  const soon = (ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void syncNow(), ms);
  };
  onDirty(() => soon(8000));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') soon(300);
    else if (isDirty()) void syncNow(); // best effort before the OS suspends us
  });
  window.addEventListener('online', () => soon(500));
  setInterval(() => document.visibilityState === 'visible' && soon(0), 3 * 60_000);
  void getKV<number>('sync.last', 0).then((last) => {
    if (status.state === 'idle') setStatus({ state: 'idle', lastSync: last || undefined });
  });
  soon(500);
}

export async function connectDrive() {
  await drive.requestToken(true);
  await drive.getAccountEmail().catch(() => undefined); // remember which account was chosen
  setStatus({ state: 'idle' });
  markDirty();
  await syncNow();
}

export function disconnectDrive() {
  drive.disconnect();
  setStatus({ state: 'off' });
}
