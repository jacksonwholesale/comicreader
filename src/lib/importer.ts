import { db, type Comic } from '../db';
import { detectFormat, imagesToCbz, isImageName, openComic, parseComicInfo, parseFileName, type ComicSource } from './archive';
import { markDirty } from './syncState';

/**
 * Stable id derived from file content (size + head + tail), so the same comic gets the
 * same id on phone and desktop without hashing hundreds of MB.
 */
export async function comicId(blob: Blob): Promise<string> {
  const chunk = 1024 * 1024;
  const parts: BlobPart[] = [String(blob.size), blob.slice(0, chunk)];
  if (blob.size > chunk * 2) parts.push(blob.slice(blob.size - chunk));
  const buf = await new Blob(parts).arrayBuffer();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadImage(url: string) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

async function thumb(url: string, width: number, quality: number, asDataUrl: true): Promise<string>;
async function thumb(url: string, width: number, quality: number, asDataUrl?: false): Promise<Blob>;
async function thumb(url: string, width: number, quality: number, asDataUrl = false) {
  const img = await loadImage(url);
  const scale = Math.min(1, width / img.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (asDataUrl) return canvas.toDataURL('image/jpeg', quality);
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('thumb failed'))), 'image/webp', quality));
}

// Small cover that travels inside the sync file, so devices without the comic still show it.
const TINY_COVER = 160;

export async function makeCovers(src: ComicSource) {
  return coversFromUrl(await src.pageUrl(0));
}

async function coversFromUrl(url: string) {
  const [cover, coverTiny] = await Promise.all([thumb(url, 360, 0.82), thumb(url, TINY_COVER, 0.62, true)]);
  return { cover, coverTiny };
}

/** Covers from a single image (e.g. the first page pulled from the start of a big RAR in Drive). */
export async function applyCoverImage(comicId: string, image: Blob) {
  const url = URL.createObjectURL(image);
  try {
    const comic = await db.comics.get(comicId);
    if (!comic) return;
    const { cover, coverTiny } = await coversFromUrl(url);
    if (comic.coverTiny) await db.comics.update(comicId, { cover });
    else {
      await db.comics.update(comicId, { cover, coverTiny, updatedAt: Date.now() });
      markDirty();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fill in what we learn by opening a comic that was only known from Drive: page count,
 * ComicInfo metadata (without overwriting your edits) and covers.
 */
export async function applySourceInfo(comicId: string, src: ComicSource) {
  const comic = await db.comics.get(comicId);
  if (!comic) return;
  const patch: Partial<Comic> = {};
  if (comic.pageCount !== src.pageCount) patch.pageCount = src.pageCount;
  if (!comic.cover) {
    const covers = await makeCovers(src).catch(() => null);
    if (covers) {
      patch.cover = covers.cover;
      if (!comic.coverTiny) patch.coverTiny = covers.coverTiny;
    }
  }
  if (!comic.infoRead) {
    const info = stripEmpty(parseComicInfo(src.comicInfoXml));
    for (const k of ['title', 'series', 'number', 'volume', 'year', 'publisher', 'writer', 'artist', 'summary'] as const) {
      if (info[k] !== undefined) (patch as any)[k] = info[k];
    }
    if (info.manga) patch.mangaHint = 1;
    patch.infoRead = 1;
  }
  if (!Object.keys(patch).length) return;
  // covers are device-local; only synced fields bump updatedAt
  const synced = Object.keys(patch).some((k) => k !== 'cover');
  await db.comics.update(comicId, synced ? { ...patch, updatedAt: Date.now() } : patch);
  if (synced) markDirty();
}

/** Store a downloaded file for a comic already in the library (e.g. from Drive), keeping its id. */
export async function attachFile(comicId: string, blob: Blob) {
  const comic = await db.comics.get(comicId);
  if (!comic) throw new Error('Comic not found');
  const src = await openComic(blob, comic.fileName);
  try {
    await db.files.put({ id: comicId, blob });
    await db.comics.update(comicId, { hasFile: 1, size: blob.size });
    await applySourceInfo(comicId, src);
  } finally {
    src.close();
  }
}

export interface ImportResult {
  added: number;
  skipped: number;
  failed: { name: string; error: string }[];
}

export function isComicFile(name: string) {
  return detectFormat(name) !== null;
}

/** Import (or re-attach the file of) one comic. Returns the comic id. */
export async function importFile(file: Blob, fileName: string, extra: Partial<Comic> = {}): Promise<{ id: string; isNew: boolean }> {
  const id = await comicId(file);
  const existing = await db.comics.get(id);
  if (existing && existing.hasFile && !existing.deleted) return { id, isNew: false };

  const src = await openComic(file, fileName);
  try {
    if (src.pageCount === 0) throw new Error('No pages found');
    const coverUrl = await src.pageUrl(0);
    const [cover, coverTiny] = await Promise.all([thumb(coverUrl, 360, 0.82), thumb(coverUrl, TINY_COVER, 0.62, true)]);
    const info = { ...parseFileName(fileName), ...stripEmpty(parseComicInfo(src.comicInfoXml)) };
    const now = Date.now();
    const comic: Comic = {
      title:
        info.title ||
        [info.series, info.number ? `#${info.number}` : info.volume && `Vol. ${info.volume}`].filter(Boolean).join(' ') ||
        fileName,
      series: info.series || 'Unsorted',
      number: info.number,
      volume: info.volume,
      year: info.year,
      publisher: info.publisher,
      writer: info.writer,
      artist: info.artist,
      summary: info.summary,
      mangaHint: info.manga ? 1 : 0,
      infoRead: 1,
      addedAt: now,
      // keep user-edited fields/overrides from a synced record that lacked the file
      ...existing,
      ...extra,
      id,
      fileName,
      format: src.format,
      size: file.size,
      pageCount: src.pageCount,
      cover,
      coverTiny,
      hasFile: 1,
      deleted: 0,
      updatedAt: now,
    };
    await db.transaction('rw', db.comics, db.files, async () => {
      await db.files.put({ id, blob: file });
      await db.comics.put(comic);
    });
    markDirty();
    return { id, isNew: !existing || !!existing.deleted };
  } finally {
    src.close();
  }
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** A file picked/dropped by the user, with its folder path (for grouping loose images). */
export interface PickedFile {
  file: Blob;
  name: string;
  path: string;
}

export interface ImportItem {
  name: string;
  load: () => Promise<Blob>;
}

/** Comic files import as-is; loose images are grouped per folder into one comic each. */
export function toImportItems(files: PickedFile[]): ImportItem[] {
  const items: ImportItem[] = [];
  const imageGroups = new Map<string, PickedFile[]>();
  for (const f of files) {
    if (isComicFile(f.name)) items.push({ name: f.name, load: async () => f.file });
    else if (isImageName(f.name)) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      imageGroups.set(dir, [...(imageGroups.get(dir) ?? []), f]);
    }
  }
  for (const [dir, imgs] of imageGroups) {
    const folderName = dir.split('/').pop() || imgs[0].name.replace(/\.[^.]+$/, '');
    items.push({ name: `${folderName}.cbz`, load: () => imagesToCbz(imgs) });
  }
  return items;
}

export async function importFiles(
  items: ImportItem[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const { load, name } of items) {
    onProgress?.(done, items.length, name);
    try {
      const r = await importFile(await load(), name);
      r.isNew ? result.added++ : result.skipped++;
    } catch (e) {
      result.failed.push({ name, error: (e as Error).message });
    }
    done++;
  }
  onProgress?.(done, items.length, '');
  return result;
}

const wanted = (name: string) => isComicFile(name) || isImageName(name);

export function fromFileList(list: FileList | File[]): PickedFile[] {
  return [...list]
    .filter((f) => wanted(f.name))
    .map((f) => ({ file: f, name: f.name, path: (f as any).webkitRelativePath || f.name }));
}

/** Recursively collect files from a directory picked with the File System Access API. */
export async function collectFromDirectory(dir: FileSystemDirectoryHandle, prefix = `${dir.name}/`): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    if (entry.kind === 'directory') {
      out.push(...(await collectFromDirectory(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`)));
    } else if (wanted(entry.name)) {
      out.push({ file: await (entry as FileSystemFileHandle).getFile(), name: entry.name, path: prefix + entry.name });
    }
  }
  return out;
}

/** Collect files from a drag-and-drop, descending into dropped folders. */
export async function collectFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return fromFileList(dt.files);
  const out: PickedFile[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      if (wanted(e.name)) {
        const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
        out.push({ file: f, name: f.name, path: e.fullPath.replace(/^\//, '') });
      }
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
