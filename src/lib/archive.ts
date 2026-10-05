import JSZip from 'jszip';
import type { ComicFormat } from '../db';

const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|jxl)$/i;

export interface ComicSource {
  format: ComicFormat;
  pageCount: number;
  /** Returns an object URL for the page image. Cached; released by close(). */
  pageUrl(index: number): Promise<string>;
  comicInfoXml?: string;
  close(): void;
}

/** Natural sort so "page2" comes before "page10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortPages(names: string[]) {
  return names
    .filter((n) => IMAGE_RE.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n))
    .sort(collator.compare);
}

const EXT_FORMAT: Record<string, ComicFormat> = {
  cbz: 'cbz', zip: 'cbz',
  cbr: 'cbr', rar: 'cbr',
  cb7: 'cb7', '7z': 'cb7',
  cbt: 'cbt', tar: 'cbt',
  pdf: 'pdf',
  epub: 'epub',
};

export const ACCEPT = Object.keys(EXT_FORMAT).map((e) => `.${e}`).join(',');
export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.avif,.bmp';
export const isImageName = (n: string) => IMAGE_RE.test(n);

/** Content sniffing wins over the extension, so mislabelled files (a .cbr that is really a zip) still open. */
export function detectFormat(name: string, head?: Uint8Array): ComicFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (head && head.length >= 8) {
    const ascii = (from: number, len: number) => String.fromCharCode(...head.slice(from, from + len));
    if (head[0] === 0x50 && head[1] === 0x4b) return ext === 'epub' ? 'epub' : 'cbz';
    if (ascii(0, 4) === 'Rar!') return 'cbr';
    if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return 'cb7';
    if (ascii(0, 4) === '%PDF') return 'pdf';
    if (head.length >= 262 && ascii(257, 5) === 'ustar') return 'cbt';
  }
  return EXT_FORMAT[ext] ?? null;
}

export async function openComic(blob: Blob, fileName: string): Promise<ComicSource> {
  const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  const format = detectFormat(fileName, head);
  switch (format) {
    case 'cbz':
    case 'epub':
      return openZip(blob);
    case 'cbr':
      try {
        return await openRar(blob);
      } catch {
        return openWith7z(blob, 'cbr'); // some RAR5 variants
      }
    case 'cb7':
    case 'cbt':
      return openWith7z(blob, format);
    case 'pdf':
      return openPdf(blob);
  }
  throw new Error(`Unsupported file: ${fileName}`);
}

export function urlCache(load: (i: number) => Promise<Blob>, pageCount: number) {
  const cache = new Map<number, Promise<string>>();
  return {
    pageUrl(i: number) {
      if (i < 0 || i >= pageCount) return Promise.reject(new Error('page out of range'));
      let p = cache.get(i);
      if (!p) {
        p = load(i).then((b) => URL.createObjectURL(b));
        p.catch(() => cache.delete(i));
        cache.set(i, p);
      }
      return p;
    },
    release() {
      for (const p of cache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      cache.clear();
    },
  };
}

export function mimeFor(name: string) {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
}

/** Anything that can list entries and read one by name: an in-memory zip, or a zip streamed from Drive. */
export interface ArchiveReader {
  names: string[];
  read(name: string): Promise<Uint8Array>;
  close?(): void;
}

async function openZip(blob: Blob): Promise<ComicSource> {
  const zip = await JSZip.loadAsync(blob);
  return sourceFromArchive({
    names: Object.keys(zip.files).filter((n) => !zip.files[n].dir),
    read: (n) => zip.files[n].async('uint8array'),
  });
}

/** CBZ or EPUB pages from a zip-like archive, reading only the entries actually needed. */
export async function sourceFromArchive(ar: ArchiveReader): Promise<ComicSource> {
  const has = new Set(ar.names);
  const text = async (n: string) => (has.has(n) ? new TextDecoder().decode(await ar.read(n)) : undefined);
  const isEpub = has.has('mimetype') && (await text('mimetype'))?.trim() === 'application/epub+zip';
  let names: string[] = [];
  let comicInfoXml: string | undefined;
  if (isEpub) {
    const epub = await epubPages({ has: (n) => has.has(n), text });
    names = epub.pages;
    comicInfoXml = epub.comicInfoXml;
  }
  if (!names.length) names = sortPages(ar.names);
  if (!comicInfoXml) {
    const infoEntry = ar.names.find((n) => /(^|\/)comicinfo\.xml$/i.test(n));
    comicInfoXml = infoEntry ? await text(infoEntry) : undefined;
  }
  const c = urlCache(async (i) => new Blob([(await ar.read(names[i])) as BlobPart], { type: mimeFor(names[i]) }), names.length);
  return {
    format: isEpub ? 'epub' : 'cbz',
    pageCount: names.length,
    pageUrl: c.pageUrl,
    comicInfoXml,
    close() {
      c.release();
      ar.close?.();
    },
  };
}

/**
 * Image-based (fixed-layout) EPUB comics/manga: walk the spine in order and take the
 * image each page shows. Also turns the OPF's Dublin Core data into ComicInfo-style XML.
 */
async function epubPages(zip: { has(n: string): boolean; text(n: string): Promise<string | undefined> }): Promise<{ pages: string[]; comicInfoXml?: string }> {
  const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
  const resolve = (base: string, href: string) => {
    const parts = (base.replace(/[^/]*$/, '') + decodeURIComponent(href.split('#')[0])).split('/');
    const out: string[] = [];
    for (const p of parts) p === '..' ? out.pop() : p && p !== '.' && out.push(p);
    return out.join('/');
  };
  const container = await zip.text('META-INF/container.xml');
  const opfPath = container && parse(container).querySelector('rootfile')?.getAttribute('full-path');
  const opfText = opfPath && (await zip.text(opfPath));
  if (!opfPath || !opfText) return { pages: [] };
  const opf = parse(opfText);
  const manifest = new Map<string, { href: string; type: string }>();
  opf.querySelectorAll('manifest > item').forEach((it) =>
    manifest.set(it.getAttribute('id')!, { href: resolve(opfPath, it.getAttribute('href')!), type: it.getAttribute('media-type') ?? '' }),
  );
  const pages: string[] = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item) continue;
    if (item.type.startsWith('image/')) {
      pages.push(item.href);
      continue;
    }
    const html = await zip.text(item.href);
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector('img[src], image[href], image[*|href]');
    const src = el?.getAttribute('src') ?? el?.getAttribute('href') ?? el?.getAttribute('xlink:href');
    if (src && zip.has(resolve(item.href, src))) pages.push(resolve(item.href, src));
  }
  const dc = (tag: string) => opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag)[0]?.textContent?.trim();
  const esc = (s?: string) => (s ?? '').replace(/[<&>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const rtl = opf.querySelector('spine')?.getAttribute('page-progression-direction') === 'rtl';
  const year = dc('date')?.slice(0, 4);
  const comicInfoXml =
    `<ComicInfo><Title>${esc(dc('title'))}</Title><Writer>${esc(dc('creator'))}</Writer>` +
    `<Publisher>${esc(dc('publisher'))}</Publisher><Summary>${esc(dc('description'))}</Summary>` +
    `${year ? `<Year>${year}</Year>` : ''}${rtl ? '<Manga>YesAndRightToLeft</Manga>' : ''}</ComicInfo>`;
  return { pages: [...new Set(pages)], comicInfoXml };
}

let sevenZipWasm: Promise<ArrayBuffer> | null = null;
/** 7z, tar and RAR fallback via the 7-Zip wasm build. Extracts everything into memory once. */
async function openWith7z(blob: Blob, format: ComicFormat): Promise<ComicSource> {
  const { default: SevenZip } = await import('7z-wasm');
  if (!sevenZipWasm) {
    const { default: url } = await import('7z-wasm/7zz.wasm?url');
    sevenZipWasm = fetch(url).then((r) => r.arrayBuffer());
  }
  const sz = await SevenZip({ wasmBinary: await sevenZipWasm, print: () => {}, printErr: () => {} });
  sz.FS.mkdir('/in');
  sz.FS.mkdir('/out');
  sz.FS.writeFile('/in/archive', new Uint8Array(await blob.arrayBuffer()));
  sz.callMain(['x', '/in/archive', '-o/out', '-y', '-bso0', '-bsp0']);
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string, rel: string) => {
    for (const name of sz.FS.readdir(dir) as string[]) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      const st = sz.FS.stat(full);
      if (sz.FS.isDir(st.mode)) walk(full, `${rel}${name}/`);
      else files.set(`${rel}${name}`, sz.FS.readFile(full) as Uint8Array);
    }
  };
  walk('/out', '');
  if (!files.size) throw new Error('Could not extract archive');
  const names = sortPages([...files.keys()]);
  const infoName = [...files.keys()].find((n) => /(^|\/)comicinfo\.xml$/i.test(n));
  const comicInfoXml = infoName ? new TextDecoder().decode(files.get(infoName)) : undefined;
  const c = urlCache(async (i) => new Blob([files.get(names[i]) as BlobPart], { type: mimeFor(names[i]) }), names.length);
  return {
    format,
    pageCount: names.length,
    pageUrl: c.pageUrl,
    comicInfoXml,
    close() {
      c.release();
      files.clear();
    },
  };
}

/** Package a set of loose images (e.g. a dropped folder) as an uncompressed CBZ. */
export async function imagesToCbz(images: { file: Blob; name: string }[]): Promise<Blob> {
  const zip = new JSZip();
  const sorted = [...images].sort((a, b) => collator.compare(a.name, b.name));
  // fixed timestamps keep the bytes (and so the comic id) identical on every device
  sorted.forEach((img, i) =>
    zip.file(`${String(i + 1).padStart(4, '0')}_${img.name.split('/').pop()}`, img.file, { date: new Date(2000, 0, 1) }),
  );
  return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/vnd.comicbook+zip' });
}

let wasmPromise: Promise<ArrayBuffer> | null = null;
async function unrarWasm() {
  if (!wasmPromise) {
    const { default: url } = await import('node-unrar-js/esm/js/unrar.wasm?url');
    wasmPromise = fetch(url).then((r) => r.arrayBuffer());
  }
  return wasmPromise;
}

/**
 * Best cover guess from just the beginning of a RAR (used for solid archives, which can't be
 * read page by page): of the images that fit in the bytes given, the one whose name sorts first.
 * Returns null if no complete image fits.
 */
export async function firstImageFromRarHead(head: Uint8Array): Promise<Blob | null> {
  const { createExtractorFromData } = await import('node-unrar-js');
  const wasmBinary = await unrarWasm();
  let best: { name: string; bytes: Uint8Array } | null = null;
  try {
    const data = head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength) as ArrayBuffer;
    const extractor = await createExtractorFromData({ wasmBinary, data });
    (extractor as any).unrar.extractor = extractor;
    const files = extractor.extract({ files: (h) => !h.flags.directory && IMAGE_RE.test(h.name) && !/(^|\/)(__MACOSX|\.)/.test(h.name) }).files;
    // Keep every image that fits; the cover is whichever sorts first (scanner tags often come first in storage order).
    try {
      for (const f of files) {
        if (f.extraction && (!best || collator.compare(f.fileHeader.name, best.name) < 0)) best = { name: f.fileHeader.name, bytes: f.extraction };
      }
    } catch {
      /* ran past the end of the bytes we fetched */
    }
  } catch {
    /* not readable */
  }
  return best ? new Blob([best.bytes as BlobPart], { type: mimeFor(best.name) }) : null;
}

async function openRar(blob: Blob): Promise<ComicSource> {
  const { createExtractorFromData } = await import('node-unrar-js');
  const data = await blob.arrayBuffer();
  const wasmBinary = await unrarWasm();
  const extractor = await createExtractorFromData({ wasmBinary, data });
  (extractor as any).unrar.extractor = extractor;
  const headers = [...extractor.getFileList().fileHeaders].filter((h) => !h.flags.directory);
  const names = sortPages(headers.map((h) => h.name));
  const solid = headers.some((h) => h.flags.solid);

  const extract = (files: string[]) => {
    // node-unrar-js routes I/O through a module-wide "current extractor"; reclaim it
    // so several open RAR comics (e.g. reading while importing) don't clash.
    (extractor as any).unrar.extractor = extractor;
    const out = new Map<string, Uint8Array>();
    for (const f of extractor.extract({ files }).files) {
      if (f.extraction) out.set(f.fileHeader.name, f.extraction);
    }
    return out;
  };

  // Solid archives must be decompressed sequentially anyway, so unpack everything once.
  let all: Map<string, Uint8Array> | null = solid ? extract(names) : null;
  const infoName = headers.map((h) => h.name).find((n) => /(^|\/)comicinfo\.xml$/i.test(n));
  let comicInfoXml: string | undefined;
  if (infoName) {
    const bytes = extract([infoName]).get(infoName);
    if (bytes) comicInfoXml = new TextDecoder().decode(bytes);
  }

  const c = urlCache(async (i) => {
    const name = names[i];
    const bytes = all ? all.get(name) : extract([name]).get(name);
    if (!bytes) throw new Error(`Could not read ${name}`);
    return new Blob([bytes as BlobPart], { type: mimeFor(name) });
  }, names.length);

  return {
    format: 'cbr',
    pageCount: names.length,
    pageUrl: c.pageUrl,
    comicInfoXml,
    close() {
      c.release();
      all = null;
    },
  };
}

async function openPdf(blob: Blob): Promise<ComicSource> {
  const data = new Uint8Array(await blob.arrayBuffer());
  return openPdfWith(() => ({ data }));
}

// The "legacy" build of pdf.js includes fallbacks for older browsers (e.g. iPhones a few iOS
// versions behind), which the modern build silently fails on.
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** Opens a PDF from whatever getDocument() params the caller builds (in-memory bytes, or a range transport). */
export async function openPdfWith(params: (pdfjs: PdfJs) => object): Promise<ComicSource> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { default: workerUrl } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // wasmUrl: JPEG 2000 / JBIG2 decoders (copied to public/pdfjs by scripts/copy-pdf-decoders.mjs)
  const task = pdfjs.getDocument({ wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href, ...params(pdfjs) });
  const doc = await task.promise;
  // Phones (iPhone especially) have a small budget for canvas memory: render a bit smaller there,
  // one page at a time, and free each canvas as soon as its image is made.
  const touch = matchMedia('(pointer: coarse)').matches;
  const target = Math.min(touch ? 2000 : 2400, Math.max(1400, Math.round(screen.height * devicePixelRatio)));
  const maxPixels = touch ? 5_000_000 : 9_000_000;
  let queue: Promise<unknown> = Promise.resolve();
  const render = async (i: number) => {
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(target / base.height, Math.sqrt(maxPixels / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      // 'print' intent renders without requestAnimationFrame, so imports keep going in background tabs
      await page.render({ canvas, viewport, intent: 'print' }).promise;
      return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/jpeg', 0.9));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  };
  const c = urlCache((i) => {
    const job = queue.then(() => render(i));
    queue = job.catch(() => {});
    return job;
  }, doc.numPages);
  return {
    format: 'pdf',
    pageCount: doc.numPages,
    pageUrl: c.pageUrl,
    close() {
      c.release();
      void task.destroy();
    },
  };
}

export interface ComicInfo {
  title?: string;
  series?: string;
  number?: string;
  volume?: string;
  year?: number;
  publisher?: string;
  writer?: string;
  artist?: string;
  summary?: string;
  manga?: boolean;
}

export function parseComicInfo(xml?: string): ComicInfo {
  if (!xml) return {};
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const get = (tag: string) => doc.getElementsByTagName(tag)[0]?.textContent?.trim() || undefined;
  const year = Number(get('Year'));
  const manga = get('Manga');
  return {
    title: get('Title'),
    series: get('Series'),
    number: get('Number'),
    volume: get('Volume'),
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    publisher: get('Publisher'),
    writer: get('Writer'),
    artist: get('Penciller') || get('Artist'),
    summary: get('Summary'),
    manga: manga ? /yesandrighttoleft/i.test(manga) : undefined,
  };
}

/** Best-effort metadata from names like "Saga 012 (2013) (Digital).cbz". */
export function parseFileName(fileName: string): ComicInfo {
  let base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const year = base.match(/\((\d{4})\)/)?.[1];
  base = base.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  // Take the volume out first so "Berserk Vol 3" is volume 3, not issue #3.
  const volMatch = base.match(/\b(?:v|vol\.?|volume)\s*(\d+)/i);
  const vol = volMatch?.[1];
  const rest = volMatch ? base.replace(volMatch[0], ' ').replace(/\s+/g, ' ').trim() : base;
  const num = rest.match(/(?:#|\b)(\d{1,4}(?:\.\d+)?)\s*$/)?.[1] ?? rest.match(/#(\d{1,4}(?:\.\d+)?)/)?.[1];
  let series = rest;
  if (num) series = series.replace(new RegExp(`\\s*#?${num.replace('.', '\\.')}\\s*$`), '');
  series = series.replace(/[-–\s]+$/, '').trim();
  return {
    series: series || base,
    number: num?.replace(/^0+(?=\d)/, ''),
    volume: vol,
    year: year ? Number(year) : undefined,
  };
}
