import { db, type Comic } from '../db';
import { firstImageFromRarHead, openComic, openPdfWith, sortPages, sourceFromArchive, urlCache, type ArchiveReader, type ComicSource } from './archive';
import { getRarIndex, RarNotSplittable, readRarEntry } from './rar';
import { downloadComic, fetchRange } from './drive';

/**
 * Read comics straight from Google Drive without saving them to the device.
 *  - CBZ / EPUB: read the zip's index from the end of the file, then fetch each page's bytes on demand.
 *  - PDF: pdf.js asks for byte ranges as it needs them.
 *  - CBR / CB7 / CBT: these can't be read piecemeal, so the whole file is held in memory while open.
 */

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

interface Entry {
  name: string;
  method: number;
  compSize: number;
  offset: number;
}

class NotStreamable extends Error {}

/** A zip archive in Drive, read with HTTP range requests. */
export async function openRemoteZip(fileId: string, size: number): Promise<ArchiveReader> {
  const tailLen = Math.min(size, 65557 + 22);
  const tail = await fetchRange(fileId, size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new NotStreamable('not a zip');
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // zip64: locator sits just before the classic end record
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new NotStreamable('bad zip64');
    const recOffset = u64(tail, loc + 8);
    const rec = await fetchRange(fileId, recOffset, recOffset + 55);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  const cdStart = size - tailLen;
  const cd = cdOffset >= cdStart ? tail.subarray(cdOffset - cdStart, cdOffset - cdStart + cdSize) : await fetchRange(fileId, cdOffset, cdOffset + cdSize - 1);

  const entries = new Map<string, Entry>();
  const dec = new TextDecoder();
  for (let p = 0; p + 46 <= cd.length && u32(cd, p) === 0x02014b50; ) {
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20);
    let uncomp = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // zip64 extra field carries whichever of the sizes/offset overflowed
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (uncomp === 0xffffffff) (uncomp = u64(cd, q)), (q += 8);
        if (compSize === 0xffffffff) (compSize = u64(cd, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { name, method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new NotStreamable('empty zip');
  for (const e of entries.values()) if (e.method !== 0 && e.method !== 8) throw new NotStreamable(`compression method ${e.method}`);

  return {
    names: [...entries.keys()],
    async read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`missing ${name}`);
      // One request: local header (30 + name + extra, extra guessed generously) plus the data.
      const slack = 30 + 1024 + name.length * 4;
      let chunk = await fetchRange(fileId, e.offset, Math.min(size - 1, e.offset + slack + e.compSize));
      const dataStart = 30 + u16(chunk, 26) + u16(chunk, 28);
      if (dataStart + e.compSize > chunk.length) chunk = await fetchRange(fileId, e.offset, e.offset + dataStart + e.compSize - 1);
      const data = chunk.subarray(dataStart, dataStart + e.compSize);
      if (e.method === 0) return data;
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };
}

async function openRemotePdf(fileId: string, size: number): Promise<ComicSource> {
  const first = await fetchRange(fileId, 0, Math.min(size, 256 * 1024) - 1);
  return openPdfWith((pdfjs) => {
    const transport = new pdfjs.PDFDataRangeTransport(size, first);
    transport.requestDataRange = (begin: number, end: number) => {
      fetchRange(fileId, begin, end - 1).then(
        (chunk) => transport.onDataRange(begin, chunk),
        () => {},
      );
    };
    return { range: transport, length: size, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true };
  });
}

/**
 * Opens a comic for reading: from the device if downloaded, otherwise streamed from Drive.
 * onProgress reports download progress for formats that must be fetched whole.
 */
/** A CBR in Drive, page by page via its cached header index. */
async function openRemoteRar(comic: Comic, onStatus?: (text: string) => void): Promise<ComicSource> {
  const fileId = comic.driveFileId!;
  const index = await getRarIndex(fileId, comic.size, comic.driveModified, (n) => onStatus?.(`Preparing pages… ${n}`));
  const byName = new Map(index.entries.map((e) => [e.name, e]));
  const names = sortPages([...byName.keys()]);
  const c = urlCache((i) => readRarEntry(fileId, index, byName.get(names[i])!), names.length);
  return { format: 'cbr', pageCount: names.length, pageUrl: c.pageUrl, close: c.release };
}

export async function openForReading(
  comic: Comic,
  onProgress?: (fraction: number) => void,
  onStatus?: (text: string) => void,
): Promise<ComicSource> {
  const local = await db.files.get(comic.id);
  if (local) return openComic(local.blob, comic.fileName);
  if (!comic.driveFileId) throw new Error('This comic is not downloaded on this device and is not in Google Drive.');
  if (!navigator.onLine) throw new Error("You're offline, and this comic isn't downloaded. Download it while online to read it offline.");
  const size = comic.size;
  try {
    if (size && (comic.format === 'cbz' || comic.format === 'epub')) return await sourceFromArchive(await openRemoteZip(comic.driveFileId, size));
    if (size && comic.format === 'pdf') return await openRemotePdf(comic.driveFileId, size);
    if (size && comic.format === 'cbr') {
      try {
        const src = await openRemoteRar(comic, onStatus);
        try {
          await src.pageUrl(0); // prove pages really come out before committing to streaming
          return src;
        } catch (e) {
          src.close();
          throw e;
        }
      } catch (e) {
        noteRarIssue(comic, e);
        onStatus?.('Loading from Google Drive…');
        // fall through to the whole-file download below
      }
    }
  } catch (e) {
    if (!(e instanceof NotStreamable) && !(e instanceof RarNotSplittable)) throw e;
    // mislabelled or unusual file: fall back to fetching it whole
  }
  const blob = await downloadComic(comic.driveFileId, onProgress);
  return openComic(blob, comic.fileName);
}

/** True when a format streams page-by-page (vs. being fetched whole each time it's opened). */
export function streamsPageByPage(comic: Comic) {
  return comic.format === 'cbz' || comic.format === 'epub' || comic.format === 'pdf';
}

/**
 * Cover of a CBR in Drive without downloading it: page 1 by sorted name via the header index,
 * or (for solid archives that can't be split) the first image stored in the file.
 */
export async function rarCoverFromDrive(comic: Comic): Promise<Blob | null> {
  if (!comic.driveFileId || !comic.size) return null;
  try {
    const index = await getRarIndex(comic.driveFileId, comic.size, comic.driveModified);
    const first = sortPages(index.entries.map((e) => e.name))[0];
    return await readRarEntry(comic.driveFileId, index, index.entries.find((e) => e.name === first)!);
  } catch (e) {
    noteRarIssue(comic, e);
  }
  for (const mb of [4, 16]) {
    const end = Math.min(comic.size, mb * 1024 * 1024) - 1;
    const img = await firstImageFromRarHead(await fetchRange(comic.driveFileId, 0, end));
    if (img || end >= comic.size - 1) return img;
  }
  return null;
}

/** CBRs that couldn't be read page by page, and why (shown in Settings; per device). */
export function getRarIssues(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('rar.issues') || '{}');
  } catch {
    return {};
  }
}

function noteRarIssue(comic: Comic, e: unknown) {
  const issues = getRarIssues();
  issues[comic.fileName] = e instanceof RarNotSplittable ? `can't stream: ${e.message}` : `error: ${(e as Error)?.message ?? e}`;
  try {
    localStorage.setItem('rar.issues', JSON.stringify(issues));
  } catch {}
}
