import type { Direction } from '../db';
import { loadImage } from './importer';

/** Normalised rectangle (0..1 of page width/height). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Panel detection for the guided (panel-by-panel) view. No AI: classic image analysis on a
 * downscaled copy of the page.
 *
 *  1. Gutter colour = the dominant colour around the page edge (white, black, …).
 *  2. "Shape" detector: flood-fill the gutter in from the edges; everything the fill can't reach
 *     is panel. Thin bridges (balloon tails, lines across a gutter) are eroded away first, then
 *     connected regions become panels. Handles slanted borders and irregular layouts.
 *  3. "Cut" detector: recursively slice along rows/columns that are (almost) empty — tolerant of
 *     small bits of art crossing a gutter. Used on regions the shape detector left too big, and
 *     as a second opinion for the whole page.
 *  4. Reading order: group panels into tiers (allowing slight overlaps), then left→right
 *     (right→left for manga).
 *  5. Pages with no detectable panels (splashes, full-bleed art) get a guided tour instead:
 *     overlapping strips down the page, or the two halves of a spread.
 */

interface Analysis {
  w: number;
  h: number;
  ink: Uint8Array; // 1 = differs from the gutter colour
  gutter: Uint8Array; // 1 = gutter-coloured AND connected to the page edge (true gutter, not white inside a panel)
  solidSum: Int32Array; // integral image of non-gutter pixels, (w+1)*(h+1)
  hasGutters: boolean; // page edge is mostly one flat colour
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

    // Gutter colour: per-channel median of a band 2px in from the edge (skips scanner fringes).
    const samples: [number, number, number][] = [];
    const inset = Math.min(2, Math.floor(Math.min(w, h) / 4));
    const at = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      samples.push([px[i], px[i + 1], px[i + 2]]);
    };
    for (let x = inset; x < w - inset; x += 2) at(x, inset), at(x, h - 1 - inset);
    for (let y = inset; y < h - inset; y += 2) at(inset, y), at(w - 1 - inset, y);
    const med = (k: number) => samples.map((s) => s[k]).sort((a, b) => a - b)[samples.length >> 1];
    const bg = [med(0), med(1), med(2)];
    const near = (r: number, g: number, b: number) => Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) <= 70;
    const flat = samples.filter((s) => near(s[0], s[1], s[2])).length / samples.length;

    const ink = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) ink[i] = near(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) ? 0 : 1;
    const gutter = floodGutter(ink, w, h);
    const solidSum = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gutter[y * w + x] ? 0 : 1;
        solidSum[(y + 1) * (w + 1) + x + 1] = solidSum[y * (w + 1) + x + 1] + row;
      }
    }
    return { w, h, ink, gutter, solidSum, hasGutters: flat >= 0.55 };
  })();
  cache.set(url, p);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  return p;
}

type Box = { x0: number; y0: number; x1: number; y1: number }; // pixel bounds, end-exclusive
const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);

/** Share of a box that is panel (not gutter). Real panels are solid; scattered art isn't. */
function solidity(a: Analysis, b: Box) {
  const W = a.w + 1;
  const S = a.solidSum;
  const n = S[b.y1 * W + b.x1] - S[b.y0 * W + b.x1] - S[b.y1 * W + b.x0] + S[b.y0 * W + b.x0];
  return n / Math.max(1, area(b));
}

/** Background pixels reachable from the page edge = the gutters. */
function floodGutter(ink: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const gutter = new Uint8Array(n);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!gutter[i] && !ink[i]) {
      gutter[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  return gutter;
}

// ---------------------------------------------------------------- shape detector

/** Panels as connected regions that the gutter flood-fill can't reach. */
function shapePanels(a: Analysis): Box[] {
  const { w, h, gutter } = a;
  const n = w * h;
  const stack: number[] = [];
  // 1. gutter = background pixels connected to the page edge (precomputed)
  // 2. erode the panel mask so thin bridges across gutters break
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  const solid = erode(gutter, w, h, r);
  // 3. connected regions → boxes
  const label = new Int32Array(n);
  const boxes: Box[] = [];
  let next = 1;
  for (let s = 0; s < n; s++) {
    if (!solid[s] || label[s]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
    stack.push(s);
    label[s] = next;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      count++;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
      const visit = (j: number) => {
        if (solid[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < n - w) visit(i + w);
    }
    next++;
    if (count >= n * 0.004) boxes.push({ x0: Math.max(0, x0 - r), y0: Math.max(0, y0 - r), x1: Math.min(w, x1 + r), y1: Math.min(h, y1 + r) });
  }
  return mergeOverlapping(boxes.filter((b) => area(b) >= n * 0.015));
}

/** Keeps a pixel only if every pixel within r of it (a square) is set. Separable, O(n). */
function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // src marks gutter; we erode the complement (panel area)
  const rowPass = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    const off = y * w;
    const tmp = new Int32Array(w);
    for (let x = 0; x < w; x++) tmp[x] = run = src[off + x] ? 0 : run + 1; // run of panel pixels ending at x
    let back = 0;
    for (let x = w - 1; x >= 0; x--) {
      back = src[off + x] ? 0 : back + 1;
      rowPass[off + x] = tmp[x] > r && back > r ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const tmp = new Int32Array(h);
    let run = 0;
    for (let y = 0; y < h; y++) tmp[y] = run = rowPass[y * w + x] ? run + 1 : 0;
    let back = 0;
    for (let y = h - 1; y >= 0; y--) {
      back = rowPass[y * w + x] ? back + 1 : 0;
      out[y * w + x] = tmp[y] > r && back > r ? 1 : 0;
    }
  }
  return out;
}

function mergeOverlapping(boxes: Box[]): Box[] {
  const out = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        // merge when one mostly sits inside the other (art pieces of the same panel)
        if (ix > 0 && iy > 0 && ix * iy > 0.35 * Math.min(area(a), area(b))) {
          out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- cut detector

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
  const tol = (len: number) => Math.max(1, len * 0.01);
  while (y0 < y1 && rowInk(y0) <= tol(x1 - x0)) y0++;
  while (y1 > y0 && rowInk(y1 - 1) <= tol(x1 - x0)) y1--;
  while (x0 < x1 && colInk(x0) <= tol(y1 - y0)) x0++;
  while (x1 > x0 && colInk(x1 - 1) <= tol(y1 - y0)) x1--;
  return x1 - x0 > 4 && y1 - y0 > 4 ? { x0, y0, x1, y1 } : null;
}

/**
 * Split a box along gutters, judged against the true-gutter mask (so white space *inside* a
 * bordered panel never counts). Strict: a line may be at most `tolerance` non-gutter.
 * Relaxed (last resort): most of the line is gutter, so a balloon or a cape crossing a gutter
 * no longer blocks the cut.
 */
function split(a: Analysis, b: Box, horizontal: boolean, tolerance: number, relaxed = false): Box[] {
  const len = horizontal ? b.y1 - b.y0 : b.x1 - b.x0;
  const across = horizontal ? b.x1 - b.x0 : b.y1 - b.y0;
  const minGutter = Math.max(2, Math.round(Math.min(a.w, a.h) * 0.008));
  const minPart = Math.min(a.w, a.h) * 0.06;
  const empty: boolean[] = [];
  for (let i = 0; i < len; i++) {
    let n = 0;
    for (let j = 0; j < across; j++) {
      const x = horizontal ? b.x0 + j : b.x0 + i;
      const y = horizontal ? b.y0 + i : b.y0 + j;
      n += 1 - a.gutter[y * a.w + x];
    }
    empty.push(n <= across * (relaxed ? 0.45 : tolerance));
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
        if (end - start >= minPart) parts.push(horizontal ? { ...b, y0: b.y0 + start, y1: b.y0 + end } : { ...b, x0: b.x0 + start, x1: b.x0 + end });
        start = -1;
        gap = 0;
      }
    }
  }
  return parts;
}

function cutPanels(a: Analysis, b: Box, tolerance: number, horizontal = true, depth = 0, out: Box[] = []): Box[] {
  const t = trim(a, b);
  if (!t) return out;
  if (depth > 7) return out.push(t), out;
  // strict cuts in both directions first; relaxed ones only if neither works
  let used = horizontal;
  let parts: Box[] = [];
  for (const [dirH, relaxed] of [[horizontal, false], [!horizontal, false], [horizontal, true], [!horizontal, true]] as const) {
    parts = split(a, t, dirH, tolerance, relaxed);
    if (parts.length >= 2) {
      used = dirH;
      break;
    }
  }
  if (parts.length < 2) return out.push(t), out;
  for (const p of parts) cutPanels(a, p, tolerance, !used, depth + 1, out);
  return out;
}

// ---------------------------------------------------------------- reading order

/** Recursively split the set into tiers (then columns), allowing small overlaps from slanted gutters. */
function order(boxes: Box[], dir: Direction, w: number, h: number): Box[] {
  if (boxes.length <= 1) return boxes;
  const groups = (start: (b: Box) => number, end: (b: Box) => number, tol: number) => {
    const sorted = [...boxes].sort((p, q) => start(p) - start(q));
    const out: Box[][] = [];
    let reach = -Infinity; // furthest end of the current group
    for (const b of sorted) {
      if (!out.length || start(b) >= reach - tol) {
        out.push([b]);
        reach = end(b);
      } else {
        out[out.length - 1].push(b);
        reach = Math.max(reach, end(b));
      }
    }
    return out;
  };
  const tiers = groups((b) => b.y0, (b) => b.y1, h * 0.03);
  if (tiers.length > 1) return tiers.flatMap((t) => order(t, dir, w, h));
  let cols = groups((b) => b.x0, (b) => b.x1, w * 0.03);
  if (cols.length > 1) {
    if (dir === 'rtl') cols = cols.reverse();
    return cols.flatMap((c) => order(c, dir, w, h));
  }
  // tangled layout: top-to-bottom by centre, then across
  return [...boxes].sort((p, q) => {
    const dy = (p.y0 + p.y1) / 2 - (q.y0 + q.y1) / 2;
    if (Math.abs(dy) > h * 0.08) return dy;
    const dx = (p.x0 + p.x1) / 2 - (q.x0 + q.x1) / 2;
    return dir === 'rtl' ? -dx : dx;
  });
}

// ---------------------------------------------------------------- putting it together

/** A guided tour for pages without panels: strips down a tall page, halves of a spread. */
function tour(a: Analysis, dir: Direction): Box[] {
  const c = trim(a, { x0: 0, y0: 0, x1: a.w, y1: a.h }) ?? { x0: 0, y0: 0, x1: a.w, y1: a.h };
  const cw = c.x1 - c.x0;
  const ch = c.y1 - c.y0;
  if (cw > ch * 1.15) {
    const halves = [
      { ...c, x1: c.x0 + Math.round(cw * 0.55) },
      { ...c, x0: c.x0 + Math.round(cw * 0.45) },
    ];
    return dir === 'rtl' ? halves.reverse() : halves;
  }
  const band = Math.round(ch * 0.42);
  return [0, 0.29, 0.58].map((f) => ({ ...c, y0: c.y0 + Math.round(ch * f), y1: Math.min(c.y1, c.y0 + Math.round(ch * f) + band) }));
}

const coverage = (boxes: Box[], a: Analysis) => boxes.reduce((s, b) => s + area(b), 0) / (a.w * a.h);

export interface PanelResult {
  rects: Rect[];
  /** true when no real panels were found and this is the strip/half tour */
  tour: boolean;
}

export async function detectPanels(url: string, dir: Direction): Promise<PanelResult> {
  const a = await analyse(url);
  const page = { x0: 0, y0: 0, x1: a.w, y1: a.h };
  const big = a.w * a.h * 0.3;
  let boxes: Box[] = [];

  if (a.hasGutters) {
    // shape detector, with oversized regions re-split by the cut detector
    const shapes = shapePanels(a).flatMap((b) => {
      if (area(b) < big) return [b];
      const parts = cutPanels(a, b, 0.03);
      return parts.length > 1 ? parts : [b];
    });
    // second opinion: the tolerant cut detector on the whole page
    const cuts = cutPanels(a, page, 0.03).filter((b) => area(b) >= a.w * a.h * 0.015);
    // the shape detector wins when its result is sound; the cut detector is the backup
    const panelLike = (bs: Box[]) => bs.filter((b) => solidity(a, b) >= 0.6);
    const shapesOk = panelLike(shapes);
    const cutsOk = panelLike(cuts);
    const good = (bs: Box[]) => bs.length >= 2 && coverage(bs, a) >= 0.35;
    boxes = good(shapesOk) ? shapesOk : good(cutsOk) ? cutsOk : [];
  }

  const isTour = boxes.length < 2;
  if (isTour) boxes = tour(a, dir);
  else boxes = order(boxes, dir, a.w, a.h);

  const pad = 0.006;
  const rects = boxes.map((b) => {
    const x = Math.max(0, b.x0 / a.w - pad);
    const y = Math.max(0, b.y0 / a.h - pad);
    return { x, y, w: Math.min(1 - x, (b.x1 - b.x0) / a.w + pad * 2), h: Math.min(1 - y, (b.y1 - b.y0) / a.h + pad * 2) };
  });
  return { rects, tour: isTour };
}

/** Bounding box of actual content, for trimming scan borders / white margins. */
export async function contentBox(url: string): Promise<Rect | null> {
  const a = await analyse(url);
  if (!a.hasGutters) return null;
  const t = trim(a, { x0: 0, y0: 0, x1: a.w, y1: a.h });
  if (!t) return null;
  const r = { x: t.x0 / a.w, y: t.y0 / a.h, w: (t.x1 - t.x0) / a.w, h: (t.y1 - t.y0) / a.h };
  // Only crop if it removes a meaningful border and keeps most of the page.
  if (r.w * r.h > 0.97 || r.w * r.h < 0.5) return null;
  return r;
}
