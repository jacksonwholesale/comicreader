import type { Direction } from '../db';
import { loadImage } from './importer';

/** Normalised rectangle (0..1 of page width/height). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Analysis {
  w: number;
  h: number;
  ink: Uint8Array; // 1 = content, 0 = background/gutter
}

const MAX = 700;
const cache = new Map<string, Promise<Analysis>>();

function analyse(url: string): Promise<Analysis> {
  let p = cache.get(url);
  if (p) return p;
  p = (async () => {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const lum = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
    // Gutter colour = median of the outer border (usually white, sometimes black).
    const border: number[] = [];
    for (let x = 0; x < w; x += 2) border.push(lum[x], lum[(h - 1) * w + x]);
    for (let y = 0; y < h; y += 2) border.push(lum[y * w], lum[y * w + w - 1]);
    border.sort((a, b) => a - b);
    const bg = border[border.length >> 1];
    const ink = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) ink[i] = Math.abs(lum[i] - bg) > 38 ? 1 : 0;
    return { w, h, ink };
  })();
  cache.set(url, p);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  return p;
}

type Box = { x0: number; y0: number; x1: number; y1: number }; // inclusive-exclusive pixels

function trim(a: Analysis, b: Box): Box | null {
  let { x0, y0, x1, y1 } = b;
  const rowInk = (y: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) n += a.ink[y * a.w + x];
    return n;
  };
  const colInk = (x: number) => {
    let n = 0;
    for (let y = y0; y < y1; y++) n += a.ink[y * a.w + x];
    return n;
  };
  const tol = (len: number) => Math.max(1, len * 0.004);
  while (y0 < y1 && rowInk(y0) <= tol(x1 - x0)) y0++;
  while (y1 > y0 && rowInk(y1 - 1) <= tol(x1 - x0)) y1--;
  while (x0 < x1 && colInk(x0) <= tol(y1 - y0)) x0++;
  while (x1 > x0 && colInk(x1 - 1) <= tol(y1 - y0)) x1--;
  return x1 - x0 > 4 && y1 - y0 > 4 ? { x0, y0, x1, y1 } : null;
}

/** Split a box along empty gutters, horizontally or vertically. */
function split(a: Analysis, b: Box, horizontal: boolean): Box[] {
  const len = horizontal ? b.y1 - b.y0 : b.x1 - b.x0;
  const across = horizontal ? b.x1 - b.x0 : b.y1 - b.y0;
  const minGutter = Math.max(2, Math.round(Math.min(a.w, a.h) * 0.008));
  const empty: boolean[] = [];
  for (let i = 0; i < len; i++) {
    let n = 0;
    for (let j = 0; j < across; j++) {
      const x = horizontal ? b.x0 + j : b.x0 + i;
      const y = horizontal ? b.y0 + i : b.y0 + j;
      n += a.ink[y * a.w + x];
    }
    empty.push(n <= across * 0.012);
  }
  const parts: Box[] = [];
  let start = -1;
  let gap = 0;
  for (let i = 0; i <= len; i++) {
    const e = i === len || empty[i];
    if (!e) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap >= minGutter || i === len) {
        const end = i - gap + 1;
        parts.push(horizontal ? { ...b, y0: b.y0 + start, y1: b.y0 + end } : { ...b, x0: b.x0 + start, x1: b.x0 + end });
        start = -1;
        gap = 0;
      }
    }
  }
  return parts;
}

function cut(a: Analysis, b: Box, horizontal: boolean, depth: number, dir: Direction, out: Box[]) {
  const t = trim(a, b);
  if (!t) return;
  if (depth > 7) return void out.push(t);
  let parts = split(a, t, horizontal);
  let usedHorizontal = horizontal;
  if (parts.length < 2) {
    parts = split(a, t, !horizontal);
    usedHorizontal = !horizontal;
  }
  if (parts.length < 2) return void out.push(t);
  if (!usedHorizontal && dir === 'rtl') parts.reverse();
  for (const p of parts) cut(a, p, !usedHorizontal, depth + 1, dir, out);
}

export async function detectPanels(url: string, dir: Direction): Promise<Rect[]> {
  const a = await analyse(url);
  const raw: Box[] = [];
  cut(a, { x0: 0, y0: 0, x1: a.w, y1: a.h }, true, 0, dir, raw);
  const minArea = a.w * a.h * 0.015;
  const boxes = raw.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) >= minArea);
  if (boxes.length < 2) return [];
  const pad = 0.006;
  return boxes.map((b) => {
    const x = Math.max(0, b.x0 / a.w - pad);
    const y = Math.max(0, b.y0 / a.h - pad);
    return { x, y, w: Math.min(1 - x, (b.x1 - b.x0) / a.w + pad * 2), h: Math.min(1 - y, (b.y1 - b.y0) / a.h + pad * 2) };
  });
}

/** Bounding box of actual content, for trimming scan borders / white margins. */
export async function contentBox(url: string): Promise<Rect | null> {
  const a = await analyse(url);
  const t = trim(a, { x0: 0, y0: 0, x1: a.w, y1: a.h });
  if (!t) return null;
  const r = { x: t.x0 / a.w, y: t.y0 / a.h, w: (t.x1 - t.x0) / a.w, h: (t.y1 - t.y0) / a.h };
  // Only crop if it removes a meaningful border and keeps most of the page.
  if (r.w * r.h > 0.97 || r.w * r.h < 0.5) return null;
  return r;
}
