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
function sortPages(names: string[]) {
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

function urlCache(load: (i: number) => Promise<Blob>, pageCount: number) {
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

function mimeFor(name: string) {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
}

async function openZip(blob: Blob): Promise<ComicSource> {
  const zip = await JSZip.loadAsync(blob);
  const isEpub = (await zip.file('mimetype')?.async('string'))?.trim() === 'application/epub+zip';
  let names: string[] = [];
  let comicInfoXml: string | undefined;
  if (isEpub) {
    const epub = await epubPages(zip);
    names = epub.pages;
    comicInfoXml = epub.comicInfoXml;
  }
  if (!names.length) names = sortPages(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  if (!comicInfoXml) {
    const infoEntry = Object.keys(zip.files).find((n) => /(^|\/)comicinfo\.xml$/i.test(n));
    comicInfoXml = infoEntry ? await zip.files[infoEntry].async('string') : undefined;
  }
  const c = urlCache(
    async (i) => new Blob([await zip.files[names[i]].async('arraybuffer')], { type: mimeFor(names[i]) }),
    names.length,
  );
  return { format: isEpub ? 'epub' : 'cbz', pageCount: names.length, pageUrl: c.pageUrl, comicInfoXml, close: c.release };
}

/**
 * Image-based (fixed-layout) EPUB comics/manga: walk the spine in order and take the
 * image each page shows. Also turns the OPF's Dublin Core data into ComicInfo-style XML.
 */
async function epubPages(zip: JSZip): Promise<{ pages: string[]; comicInfoXml?: string }> {
  const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
  const resolve = (base: string, href: string) => {
    const parts = (base.replace(/[^/]*$/, '') + decodeURIComponent(href.split('#')[0])).split('/');
    const out: string[] = [];
    for (const p of parts) p === '..' ? out.pop() : p && p !== '.' && out.push(p);
    return out.join('/');
  };
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container && parse(container).querySelector('rootfile')?.getAttribute('full-path');
  const opfText = opfPath && (await zip.file(opfPath)?.async('string'));
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
    const html = await zip.file(item.href)?.async('string');
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector('img[src], image[href], image[*|href]');
    const src = el?.getAttribute('src') ?? el?.getAttribute('href') ?? el?.getAttribute('xlink:href');
    if (src && zip.file(resolve(item.href, src))) pages.push(resolve(item.href, src));
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
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const doc = await task.promise;
  const target = Math.min(2400, Math.max(1400, Math.round(screen.height * devicePixelRatio)));
  const c = urlCache(async (i) => {
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: target / base.height });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // 'print' intent renders without requestAnimationFrame, so imports keep going in background tabs
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/jpeg', 0.9));
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
