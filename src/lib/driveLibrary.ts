import { useSyncExternalStore } from 'react';
import { db, getKV, setKV, type Comic } from '../db';
import { detectFormat, parseFileName } from './archive';
import { FOLDER_MIME, hasFolderAccess, isConnected, listChildren, type DriveItem } from './drive';
import { applySourceInfo } from './importer';
import { openForReading, streamsPageByPage } from './remote';
import { markDirty } from './syncState';

/**
 * Drive folders linked as library sources. Every comic inside (including subfolders) shows up
 * in the library on every device; it streams when opened and can be downloaded for offline use.
 * The folder list itself syncs; each device scans on its own.
 */
export interface LinkedFolder {
  id: string;
  name: string;
  addedAt: number;
}

interface FolderState {
  value: LinkedFolder[];
  updatedAt: number;
}

export async function getLinkedFolders(): Promise<FolderState> {
  return getKV<FolderState>('driveFolders', { value: [], updatedAt: 0 });
}

/** Used by sync to apply the list from another device. */
export async function setLinkedFolders(state: FolderState) {
  await setKV('driveFolders', state);
  emit();
}

// ---- status for the UI ----

export interface LibraryStatus {
  scanning: boolean;
  scanError?: string;
  lastScan?: number;
  covers: { done: number; total: number };
}

let status: LibraryStatus = { scanning: false, covers: { done: 0, total: 0 } };
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function setStatus(p: Partial<LibraryStatus>) {
  status = { ...status, ...p };
  emit();
}
export function useDriveLibraryStatus() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => status,
  );
}
export function onFoldersChanged(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- linking ----

export async function linkFolder(folder: { id: string; name: string }) {
  const state = await getLinkedFolders();
  if (state.value.some((f) => f.id === folder.id)) return;
  await setLinkedFolders({ value: [...state.value, { ...folder, addedAt: Date.now() }], updatedAt: Date.now() });
  markDirty();
  await scanLinkedFolders(true);
}

export async function unlinkFolder(id: string) {
  const state = await getLinkedFolders();
  await setLinkedFolders({ value: state.value.filter((f) => f.id !== id), updatedAt: Date.now() });
  // Remove that folder's comics from the library, except ones downloaded to this device.
  const now = Date.now();
  await db.comics
    .filter((c) => c.driveFolderId === id && !c.deleted && !c.hasFile)
    .modify({ deleted: 1, cover: undefined, coverTiny: undefined, driveModified: undefined, updatedAt: now });
  markDirty();
}

// ---- scanning ----

const isComicName = (name: string) => detectFormat(name) !== null;

async function walk(folderId: string, depth = 0): Promise<DriveItem[]> {
  const children = await listChildren(folderId);
  const out: DriveItem[] = [];
  for (const c of children) {
    if (c.mimeType === FOLDER_MIME) {
      if (depth < 8) out.push(...(await walk(c.id, depth + 1)));
    } else if (isComicName(c.name)) out.push(c);
  }
  return out;
}

let scanning: Promise<void> | null = null;
const SCAN_EVERY = 10 * 60_000;

/** Looks for new, changed and removed files in linked folders. */
export function scanLinkedFolders(force = false): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const { value: folders } = await getLinkedFolders();
    if (!folders.length || !isConnected() || !hasFolderAccess()) return;
    const last = Number(localStorage.getItem('driveLibrary.lastScan')) || 0;
    if (!force && Date.now() - last < SCAN_EVERY) {
      setStatus({ lastScan: last });
      void buildCovers();
      return;
    }
    setStatus({ scanning: true, scanError: undefined });
    try {
      const all = await db.comics.toArray();
      const byDriveId = new Map(all.filter((c) => c.driveFileId && !c.deleted).map((c) => [c.driveFileId!, c]));
      let changed = false;
      for (const folder of folders) {
        const files = await walk(folder.id);
        const seen = new Set<string>();
        const now = Date.now();
        const writes: Comic[] = [];
        for (const f of files) {
          seen.add(f.id);
          const existing = byDriveId.get(f.id) ?? all.find((c) => c.id === `d_${f.id}`);
          // Uploaded from the app (lives under its own id): already in the library.
          if (existing && existing.id !== `d_${f.id}` && !existing.deleted) continue;
          if (existing && !existing.deleted && existing.driveModified === f.modifiedTime && existing.fileName === f.name) continue;
          // You removed it from the library: stay removed unless the file in Drive changes.
          if (existing?.deleted && existing.driveModified === f.modifiedTime) continue;
          const replaced = existing && !existing.deleted && existing.driveModified !== f.modifiedTime;
          const guess = parseFileName(f.name);
          writes.push({
            title: [guess.series, guess.number ? `#${guess.number}` : guess.volume && `Vol. ${guess.volume}`].filter(Boolean).join(' ') || f.name,
            series: guess.series || 'Unsorted',
            number: guess.number,
            volume: guess.volume,
            year: guess.year,
            pageCount: 0,
            addedAt: now,
            hasFile: 0,
            ...(existing && !existing.deleted ? existing : {}),
            ...(replaced ? { cover: undefined, coverTiny: undefined, hasFile: 0 as const, infoRead: 0 as const } : {}),
            id: `d_${f.id}`,
            fileName: f.name,
            format: detectFormat(f.name)!,
            size: f.size ?? 0,
            driveFileId: f.id,
            driveFolderId: folder.id,
            driveModified: f.modifiedTime,
            deleted: 0,
            updatedAt: now,
          });
          if (replaced) await db.files.delete(`d_${f.id}`);
        }
        // Files removed from the Drive folder leave the library (unless downloaded here).
        const gone = all.filter((c) => c.driveFolderId === folder.id && c.id.startsWith('d_') && !c.deleted && !seen.has(c.driveFileId ?? ''));
        for (const c of gone) {
          if (c.hasFile) writes.push({ ...c, driveFileId: undefined, driveFolderId: undefined, updatedAt: now });
          else writes.push({ ...c, deleted: 1, cover: undefined, coverTiny: undefined, updatedAt: now });
        }
        if (writes.length) {
          await db.comics.bulkPut(writes);
          changed = true;
        }
      }
      const t = Date.now();
      localStorage.setItem('driveLibrary.lastScan', String(t));
      setStatus({ scanning: false, lastScan: t });
      if (changed) markDirty();
      void buildCovers();
    } catch (e) {
      setStatus({ scanning: false, scanError: (e as Error).message });
    }
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

// ---- covers (and page counts / ComicInfo) for comics not on this device ----

let coversRunning = false;
const MAX_WHOLE_FILE = 150 * 1024 * 1024;

async function buildCovers() {
  if (coversRunning) return;
  coversRunning = true;
  try {
    const todo = (await db.comics.toArray()).filter(
      (c) =>
        !c.deleted &&
        !c.hasFile &&
        c.driveFileId &&
        !c.cover &&
        // RAR/7z/TAR must be downloaded whole; only do that once (the cover then syncs to other devices)
        (streamsPageByPage(c) || (!c.coverTiny && c.size <= MAX_WHOLE_FILE)),
    );
    setStatus({ covers: { done: 0, total: todo.length } });
    let done = 0;
    for (const c of todo) {
      if (!navigator.onLine) break;
      try {
        const src = await openForReading(c);
        try {
          await applySourceInfo(c.id, src);
        } finally {
          src.close();
        }
      } catch {
        /* skip files that fail; they still open from the reader with an error message */
      }
      setStatus({ covers: { done: ++done, total: todo.length } });
    }
  } finally {
    coversRunning = false;
    setStatus({ covers: { done: 0, total: 0 } });
  }
}
