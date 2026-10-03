import { db, getKV, setKV } from '../db';
import { firstImageFromRarHead } from './archive';
import { fetchRange } from './drive';

/**
 * Page-by-page reading of CBR (RAR) files in Google Drive, without downloading the whole file.
 *
 * RAR has no central directory, but every entry starts with a small header that says how big
 * its data is. We hop from header to header with tiny range requests to build an index once
 * (cached), then read any page by fetching just its header + data and handing that to unrar as
 * a one-file archive. Works for normal (non-solid) RAR4 and RAR5; solid or multi-volume archives
 * can't be split this way and fall back to downloading the whole file.
 */

export interface RarEntry {
  name: string;
  hdrOff: number; // where this entry's header starts
  end: number; // end of its data (exclusive)
}

export interface RarIndex {
  version: 4 | 5;
  entries: RarEntry[];
}

export class RarNotSplittable extends Error {}

const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

function vint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    const byte = b[p + i];
    if (byte === undefined) throw new RangeError('truncated');
    v += (byte & 0x7f) * mul;
    mul *= 128;
    if (!(byte & 0x80)) return [v, i + 1];
  }
  throw new Error('bad vint');
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Fetch bytes at [off, off+len), growing the window if a header turns out longer. */
async function readAt(fileId: string, size: number, off: number, len: number) {
  return fetchRange(fileId, off, Math.min(size, off + len) - 1);
}

const isImage = (n: string) => /\.(jpe?g|png|gif|webp|avif|bmp|jxl)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n);

export async function buildRarIndex(fileId: string, size: number, onProgress?: (n: number) => void): Promise<RarIndex> {
  const head = await readAt(fileId, size, 0, 64 * 1024);
  const is5 = SIG5.every((v, i) => head[i] === v);
  const is4 = !is5 && SIG4.every((v, i) => head[i] === v);
  if (!is4 && !is5) throw new RarNotSplittable('not a RAR file');
  const entries: RarEntry[] = [];
  // Reuse the first 64 KB for headers that fall inside it.
  const window = { off: 0, bytes: head };
  const bytesAt = async (off: number, len: number) => {
    if (off >= window.off && off + len <= window.off + window.bytes.length) return window.bytes.subarray(off - window.off);
    const bytes = await readAt(fileId, size, off, Math.max(len, 4096));
    window.off = off;
    window.bytes = bytes;
    return bytes;
  };

  let pos = is5 ? 8 : 7;
  let guard = 0;
  while (pos < size && guard++ < 100_000) {
    if (is4) {
      let b = await bytesAt(pos, 7);
      const type = b[2];
      const flags = u16(b, 3);
      const headSize = u16(b, 5);
      if (headSize < 7) break;
      b = await bytesAt(pos, headSize);
      if (type === 0x73 && flags & 0x0008) throw new RarNotSplittable('solid archive');
      if (type === 0x73 && flags & 0x0001) throw new RarNotSplittable('multi-volume archive');
      if (type === 0x7b) break; // end of archive
      let dataSize = flags & 0x8000 ? u32(b, 7) : 0;
      if (type === 0x74) {
        if (flags & 0x0100) dataSize += u32(b, 32) * 2 ** 32; // HIGH_PACK_SIZE
        const nameSize = u16(b, 26);
        const nameOff = flags & 0x0100 ? 40 : 32;
        const name = new TextDecoder().decode(b.subarray(nameOff, nameOff + nameSize)).split('\0')[0].replace(/\\/g, '/');
        const dir = (flags & 0xe0) === 0xe0;
        if (flags & 0x0004) throw new RarNotSplittable('encrypted');
        if (!dir && isImage(name)) {
          if (flags & 0x0010 && entries.length) throw new RarNotSplittable('solid archive');
          entries.push({ name, hdrOff: pos, end: pos + headSize + dataSize });
          onProgress?.(entries.length);
        }
      }
      pos += headSize + dataSize;
    } else {
      let b = await bytesAt(pos, 16);
      const [hSize, hLen] = vint(b, 4);
      const total = 4 + hLen + hSize;
      b = await bytesAt(pos, total);
      let p = 4 + hLen;
      const [type, l1] = vint(b, p);
      p += l1;
      const [hFlags, l2] = vint(b, p);
      p += l2;
      if (hFlags & 1) p += vint(b, p)[1]; // extra area size
      let dataSize = 0;
      if (hFlags & 2) {
        const [ds, l3] = vint(b, p);
        dataSize = ds;
        p += l3;
      }
      if (type === 4) throw new RarNotSplittable('encrypted headers');
      if (type === 5) break; // end of archive
      if (type === 1) {
        const [arcFlags] = vint(b, p);
        if (arcFlags & 0x0004) throw new RarNotSplittable('solid archive');
        if (arcFlags & 0x0001) throw new RarNotSplittable('multi-volume archive');
      }
      if (type === 2) {
        const [fileFlags, f1] = vint(b, p);
        p += f1;
        p += vint(b, p)[1]; // unpacked size
        p += vint(b, p)[1]; // attributes
        if (fileFlags & 2) p += 4; // mtime
        if (fileFlags & 4) p += 4; // crc
        const [comp, c1] = vint(b, p);
        p += c1;
        p += vint(b, p)[1]; // host OS
        const [nameLen, n1] = vint(b, p);
        p += n1;
        const name = new TextDecoder().decode(b.subarray(p, p + nameLen)).replace(/\\/g, '/');
        if (comp & 0x40 && entries.length) throw new RarNotSplittable('solid archive');
        if (!(fileFlags & 1) && isImage(name)) {
          entries.push({ name, hdrOff: pos, end: pos + total + dataSize });
          onProgress?.(entries.length);
        }
      }
      pos += total + dataSize;
    }
  }
  if (!entries.length) throw new RarNotSplittable('no images found');
  return { version: is5 ? 5 : 4, entries };
}

const crcT = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Minimal archive headers so a single entry can be extracted on its own. */
function miniArchive(version: 4 | 5, entryBytes: Uint8Array): Uint8Array {
  let pre: Uint8Array;
  let post: Uint8Array;
  if (version === 4) {
    const main = new Uint8Array(13);
    main[2] = 0x73;
    main[5] = 13;
    const c = crc32(main.subarray(2)) & 0xffff;
    main[0] = c & 0xff;
    main[1] = c >> 8;
    pre = new Uint8Array([...SIG4, ...main]);
    post = new Uint8Array([0xc4, 0x3d, 0x7b, 0x00, 0x40, 0x07, 0x00]);
  } else {
    const block = (body: number[]) => {
      const c = crc32(new Uint8Array(body));
      return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, c >>> 24, ...body];
    };
    pre = new Uint8Array([...SIG5, ...block([3, 1, 0, 0])]); // main header: type 1, no flags
    post = new Uint8Array(block([3, 5, 0, 0])); // end of archive
  }
  const out = new Uint8Array(pre.length + entryBytes.length + post.length);
  out.set(pre, 0);
  out.set(entryBytes, pre.length);
  out.set(post, pre.length + entryBytes.length);
  return out;
}

export async function readRarEntry(fileId: string, index: RarIndex, entry: RarEntry): Promise<Blob> {
  const bytes = await fetchRange(fileId, entry.hdrOff, entry.end - 1);
  const img = await firstImageFromRarHead(miniArchive(index.version, bytes));
  if (!img) throw new Error(`Could not read ${entry.name}`);
  return img;
}

/** Index from cache, or build it (cached per Drive file version). */
export async function getRarIndex(fileId: string, size: number, modified: string | undefined, onProgress?: (n: number) => void): Promise<RarIndex> {
  const key = `rar:${fileId}:${modified ?? ''}`;
  const cached = await getKV<RarIndex | { unsplittable: string } | null>(key, null);
  if (cached && 'unsplittable' in cached) throw new RarNotSplittable(cached.unsplittable);
  if (cached) return cached;
  try {
    const index = await buildRarIndex(fileId, size, onProgress);
    await setKV(key, index);
    return index;
  } catch (e) {
    if (e instanceof RarNotSplittable) await setKV(key, { unsplittable: e.message });
    throw e;
  }
}

/** Drop cached indexes for files that no longer exist in the library. */
export async function pruneRarIndexes(liveFileIds: Set<string>) {
  const keys = (await db.kv.toCollection().primaryKeys()) as string[];
  const stale = keys.filter((k) => k.startsWith('rar:') && !liveFileIds.has(k.split(':')[1]));
  if (stale.length) await db.kv.bulkDelete(stale);
}
