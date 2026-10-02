import type { Fit } from '../../lib/prefs';
import type { Rect } from '../../lib/panels';

export interface Dims {
  w: number;
  h: number;
}

/** Displayed size of a page (after optional crop) inside a box, for a given fit mode. */
export function layoutPage(dims: Dims | undefined, crop: Rect | null | undefined, fit: Fit, boxW: number, boxH: number) {
  const d = dims ?? { w: 2, h: 3 };
  const srcW = d.w * (crop?.w ?? 1);
  const srcH = d.h * (crop?.h ?? 1);
  let s: number;
  switch (fit) {
    case 'width':
      s = boxW / srcW;
      break;
    case 'height':
      s = boxH / srcH;
      break;
    case 'original':
      s = 1 / (window.devicePixelRatio || 1);
      break;
    default:
      s = Math.min(boxW / srcW, boxH / srcH);
  }
  return { w: srcW * s, h: srcH * s };
}

/** Groups pages into two-page spreads. Wide pages (already spreads) and optionally the cover stand alone. */
export function buildSpreads(pageCount: number, dims: Map<number, Dims>, coverAlone: boolean): number[][] {
  const views: number[][] = [];
  let i = 0;
  const wide = (p: number) => {
    const d = dims.get(p);
    return !!d && d.w > d.h * 1.05;
  };
  if (coverAlone && pageCount > 0) views.push([i++]);
  while (i < pageCount) {
    if (wide(i) || i === pageCount - 1 || wide(i + 1)) views.push([i++]);
    else {
      views.push([i, i + 1]);
      i += 2;
    }
  }
  return views;
}
