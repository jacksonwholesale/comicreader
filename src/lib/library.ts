import { db, uid, type Collection, type Comic, type Progress, type ReadingSession, type SmartRule } from '../db';
import { deleteDriveFile } from './drive';
import { device, markDirty } from './syncState';

export type Status = 'unread' | 'reading' | 'finished';

/** Set (or clear, with undefined) where comics sit in the Series view. Syncs to every device. */
export async function setShelves(updates: { id: string; shelf: string[] | undefined }[]) {
  if (!updates.length) return;
  const now = Date.now();
  await db.transaction('rw', db.comics, async () => {
    for (const u of updates) await db.comics.update(u.id, { shelf: u.shelf ? u.shelf.map((s) => s.trim()).filter(Boolean) : undefined, updatedAt: now });
  });
  markDirty();
}

/** Can be opened right now: downloaded here, or streamable from Drive. */
export function isReadable(c: Comic) {
  return !!c.hasFile || (!!c.driveFileId && !c.driveMissing);
}

export function statusOf(p?: Progress): Status {
  if (!p || (p.page === 0 && !p.finished)) return 'unread';
  return p.finished ? 'finished' : 'reading';
}

export function percentOf(p?: Progress, comic?: Comic) {
  if (!p) return 0;
  if (p.finished) return 100;
  const count = p.pageCount || comic?.pageCount || 1;
  return Math.round(((p.page + 1) / count) * 100);
}

export async function saveProgress(comic: Comic, page: number) {
  const prev = await db.progress.get(comic.id);
  // "Finished" sticks once reached (re-reads don't un-finish); "Mark unread" resets it.
  const finished: 0 | 1 = page >= comic.pageCount - 1 || prev?.finished ? 1 : 0;
  const now = Date.now();
  await db.progress.put({
    comicId: comic.id,
    page,
    pageCount: comic.pageCount,
    finished,
    lastReadAt: now,
    updatedAt: now,
    bookmarks: prev?.bookmarks ?? [],
    device: device.name,
  });
  markDirty();
}

export async function setFinished(ids: string[], finished: boolean) {
  const now = Date.now();
  await db.transaction('rw', db.progress, db.comics, async () => {
    for (const id of ids) {
      const comic = await db.comics.get(id);
      if (!comic) continue;
      const prev = await db.progress.get(id);
      await db.progress.put({
        comicId: id,
        page: finished ? comic.pageCount - 1 : 0,
        pageCount: comic.pageCount,
        finished: finished ? 1 : 0,
        lastReadAt: finished ? now : prev?.lastReadAt ?? 0,
        updatedAt: now,
        bookmarks: prev?.bookmarks ?? [],
        device: device.name,
      });
    }
  });
  markDirty();
}

/**
 * Takes a comic off "Continue reading" on every device by resetting its place to the start.
 * Reading history (time/pages stats) is kept. Returns a function that undoes it.
 */
export async function removeFromContinueReading(comicId: string): Promise<() => Promise<void>> {
  const prev = await db.progress.get(comicId);
  const now = Date.now();
  if (prev) await db.progress.put({ ...prev, page: 0, finished: 0, updatedAt: now, device: device.name });
  markDirty();
  return async () => {
    if (prev) await db.progress.put({ ...prev, updatedAt: Date.now() });
    markDirty();
  };
}

export async function toggleBookmark(comicId: string, page: number) {
  const p = await db.progress.get(comicId);
  if (!p) return;
  const has = p.bookmarks.includes(page);
  await db.progress.update(comicId, {
    bookmarks: has ? p.bookmarks.filter((b) => b !== page) : [...p.bookmarks, page].sort((a, b) => a - b),
    updatedAt: Date.now(),
  });
  markDirty();
}

export async function updateComic(id: string, patch: Partial<Comic>) {
  await db.comics.update(id, { ...patch, updatedAt: Date.now() });
  markDirty();
}

/** Frees space on this device; the comic stays in your library (and in Drive, if uploaded). */
export async function removeDownload(id: string) {
  await db.transaction('rw', db.files, db.comics, async () => {
    await db.files.delete(id);
    await db.comics.update(id, { hasFile: 0 });
  });
}

/** Deletes everywhere: this device, the synced library, and the Drive copy. */
export async function deleteComics(ids: string[]) {
  const now = Date.now();
  const driveIds: string[] = [];
  await db.transaction('rw', [db.files, db.comics, db.progress, db.collections], async () => {
    for (const id of ids) {
      const c = await db.comics.get(id);
      if (!c) continue;
      // Only delete Drive copies the app uploaded; files in your linked folders are never touched.
      if (c.driveFileId && !c.driveFolderId) driveIds.push(c.driveFileId);
      await db.files.delete(id);
      await db.comics.put({ ...c, cover: undefined, coverTiny: undefined, hasFile: 0, driveFileId: undefined, deleted: 1, updatedAt: now });
    }
    const idSet = new Set(ids);
    await db.collections.toCollection().modify((col) => {
      if (col.comicIds.some((x) => idSet.has(x))) {
        col.comicIds = col.comicIds.filter((x) => !idSet.has(x));
        col.updatedAt = now;
      }
    });
  });
  markDirty();
  driveIds.forEach((d) => void deleteDriveFile(d));
}

// ---- reading sessions ----

export function startSession(comicId: string, startPage: number) {
  const session: ReadingSession = {
    id: uid(),
    comicId,
    deviceId: device.id,
    deviceName: device.name,
    startedAt: Date.now(),
    endedAt: Date.now(),
    startPage,
    endPage: startPage,
    pagesViewed: 0,
    updatedAt: Date.now(),
  };
  const viewed = new Set<number>([startPage]);
  let saveTimer: number | undefined;
  const persist = () => {
    session.endedAt = Date.now();
    session.updatedAt = session.endedAt;
    session.pagesViewed = viewed.size;
    // ignore accidental opens
    if (session.endedAt - session.startedAt > 15_000 || viewed.size > 1) void db.sessions.put({ ...session });
  };
  return {
    page(p: number) {
      viewed.add(p);
      session.endPage = p;
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(persist, 3000);
    },
    end() {
      clearTimeout(saveTimer);
      persist();
      markDirty();
    },
  };
}

// ---- collections ----

export async function createCollection(name: string, opts: Partial<Collection> = {}): Promise<string> {
  const now = Date.now();
  const id = uid();
  await db.collections.put({ id, name: name.trim() || 'Untitled', comicIds: [], driveSync: 0, createdAt: now, updatedAt: now, ...opts });
  markDirty();
  return id;
}

export async function updateCollection(id: string, patch: Partial<Collection>) {
  await db.collections.update(id, { ...patch, updatedAt: Date.now() });
  markDirty();
}

export async function deleteCollection(id: string) {
  const c = await db.collections.get(id);
  if (!c) return;
  await db.collections.put({ ...c, comicIds: [], deleted: 1, updatedAt: Date.now() });
  markDirty();
}

export async function addToCollection(id: string, comicIds: string[]) {
  const c = await db.collections.get(id);
  if (!c) return;
  const ids = [...c.comicIds, ...comicIds.filter((x) => !c.comicIds.includes(x))];
  await updateCollection(id, { comicIds: ids });
}

export async function removeFromCollection(id: string, comicIds: string[]) {
  const c = await db.collections.get(id);
  if (!c) return;
  await updateCollection(id, { comicIds: c.comicIds.filter((x) => !comicIds.includes(x)) });
}

export function matchesSmart(rule: SmartRule, comic: Comic, p?: Progress) {
  if (rule.text) {
    const t = rule.text.toLowerCase();
    const hay = [comic.title, comic.series, comic.publisher, comic.writer, comic.artist].join(' ').toLowerCase();
    if (!hay.includes(t)) return false;
  }
  if (rule.status && rule.status !== 'any' && statusOf(p) !== rule.status) return false;
  if (rule.publisher && !(comic.publisher ?? '').toLowerCase().includes(rule.publisher.toLowerCase())) return false;
  if (rule.yearFrom && (!comic.year || comic.year < rule.yearFrom)) return false;
  if (rule.yearTo && (!comic.year || comic.year > rule.yearTo)) return false;
  if (rule.favoritesOnly && !comic.favorite) return false;
  return true;
}

export function collectionMembers(col: Collection, comics: Comic[], progress: Map<string, Progress>): Comic[] {
  if (col.smart) return sortComics(comics.filter((c) => matchesSmart(col.smart!, c, progress.get(c.id))), 'series');
  const byId = new Map(comics.map((c) => [c.id, c]));
  return col.comicIds.map((id) => byId.get(id)).filter(Boolean) as Comic[];
}

// ---- sorting ----

export type SortKey = 'series' | 'title' | 'added' | 'recent' | 'year';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortComics(list: Comic[], key: SortKey, progress?: Map<string, Progress>): Comic[] {
  const arr = [...list];
  const num = (c: Comic) => parseFloat(c.number ?? '') || 0;
  switch (key) {
    case 'series':
      return arr.sort(
        (a, b) => collator.compare(a.series, b.series) || collator.compare(a.volume ?? '', b.volume ?? '') || num(a) - num(b) || collator.compare(a.title, b.title),
      );
    case 'title':
      return arr.sort((a, b) => collator.compare(a.title, b.title));
    case 'added':
      return arr.sort((a, b) => b.addedAt - a.addedAt);
    case 'year':
      return arr.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    case 'recent':
      return arr.sort((a, b) => (progress?.get(b.id)?.lastReadAt ?? 0) - (progress?.get(a.id)?.lastReadAt ?? 0));
  }
}

/** The next unread issue in the same series, for "Up next" after finishing. */
export function nextInSeries(comic: Comic, all: Comic[]): Comic | undefined {
  const series = sortComics(all.filter((c) => c.series === comic.series && !c.deleted), 'series');
  const i = series.findIndex((c) => c.id === comic.id);
  return i >= 0 ? series[i + 1] : undefined;
}

// ---- stats ----

export function computeStats(sessions: ReadingSession[]) {
  const totalMs = sessions.reduce((s, x) => s + Math.min(x.endedAt - x.startedAt, 4 * 3600_000), 0);
  const pages = sessions.reduce((s, x) => s + x.pagesViewed, 0);
  const days = new Set(sessions.map((s) => new Date(s.startedAt).toDateString()));
  let streak = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1); // today not read yet doesn't break it
  while (days.has(d.toDateString())) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  const byDevice = new Map<string, number>();
  sessions.forEach((s) => byDevice.set(s.deviceName, (byDevice.get(s.deviceName) ?? 0) + (s.endedAt - s.startedAt)));
  return { totalMs, pages, streak, daysRead: days.size, byDevice };
}

export function formatDuration(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function timeAgo(t?: number) {
  if (!t) return 'never';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
