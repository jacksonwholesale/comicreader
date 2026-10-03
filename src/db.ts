import Dexie, { type EntityTable } from 'dexie';

export type ComicFormat = 'cbz' | 'cbr' | 'cb7' | 'cbt' | 'pdf' | 'epub';
export type ReadMode = 'paged' | 'double' | 'scroll' | 'guided';
export type Direction = 'ltr' | 'rtl';

export interface Comic {
  id: string; // content hash: identical files share an id on every device
  title: string;
  series: string;
  number?: string;
  volume?: string;
  year?: number;
  publisher?: string;
  writer?: string;
  artist?: string;
  summary?: string;
  fileName: string;
  format: ComicFormat;
  size: number;
  pageCount: number;
  addedAt: number;
  updatedAt: number;
  cover?: Blob; // ~320px thumbnail
  coverTiny?: string; // small data URL, travels through sync for devices without the file
  hasFile: 0 | 1; // 1 when the archive is stored on this device
  driveFileId?: string; // set once uploaded to Google Drive
  mangaHint?: 0 | 1; // ComicInfo says right-to-left
  readMode?: ReadMode; // per-comic override
  direction?: Direction; // per-comic override
  favorite?: 0 | 1;
  driveFolderId?: string; // set for comics that come from a linked Drive folder
  drivePath?: string[]; // folder names between the linked folder and the file (drives the Series view)
  shelf?: string[]; // your own place in the Series view (overrides Drive folders); set by rename/move
  driveMissing?: 0 | 1; // the file was removed from its Drive folder; kept until it comes back or you remove it
  driveModified?: string; // Drive modifiedTime, to notice replaced files
  infoRead?: 0 | 1; // ComicInfo/EPUB metadata already applied
  deleted?: 0 | 1; // tombstone for sync
}

export interface ComicFile {
  id: string;
  blob: Blob;
}

export interface Progress {
  comicId: string;
  page: number;
  pageCount: number;
  finished: 0 | 1;
  lastReadAt: number;
  updatedAt: number;
  bookmarks: number[];
  device?: string; // which device last moved this bookmark
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  comicIds: string[]; // ordered: doubles as a reading list
  smart?: SmartRule;
  driveSync: 0 | 1; // upload member comics to Google Drive
  createdAt: number;
  updatedAt: number;
  deleted?: 0 | 1;
}

export interface SmartRule {
  text?: string; // matches title / series / publisher / writer
  status?: 'any' | 'unread' | 'reading' | 'finished';
  publisher?: string;
  yearFrom?: number;
  yearTo?: number;
  favoritesOnly?: boolean;
}

export interface ReadingSession {
  id: string;
  comicId: string;
  deviceId: string;
  deviceName: string;
  startedAt: number;
  endedAt: number;
  startPage: number;
  endPage: number;
  pagesViewed: number;
  updatedAt: number;
}

export interface KV {
  key: string;
  value: unknown;
}

export const db = new Dexie('comicreader') as Dexie & {
  comics: EntityTable<Comic, 'id'>;
  files: EntityTable<ComicFile, 'id'>;
  progress: EntityTable<Progress, 'comicId'>;
  collections: EntityTable<Collection, 'id'>;
  sessions: EntityTable<ReadingSession, 'id'>;
  kv: EntityTable<KV, 'key'>;
};

db.version(1).stores({
  comics: 'id, series, title, addedAt, updatedAt, hasFile, deleted',
  files: 'id',
  progress: 'comicId, lastReadAt, updatedAt',
  collections: 'id, name, updatedAt',
  sessions: 'id, comicId, startedAt, updatedAt',
  kv: 'key',
});

export async function getKV<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setKV(key: string, value: unknown) {
  await db.kv.put({ key, value });
}

export function uid() {
  return crypto.randomUUID();
}
