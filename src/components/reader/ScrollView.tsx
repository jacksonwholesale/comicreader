import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComicSource } from '../../lib/archive';
import { useElementSize } from '../../lib/hooks';
import type { Dims } from './layout';

interface Props {
  source: ComicSource;
  startPage: number;
  jump: { page: number; nonce: number };
  dims: Map<number, Dims>;
  onDims: (page: number, d: Dims) => void;
  onPage: (page: number) => void;
  onTap: (x: number, y: number, w: number, h: number) => void;
  gap: number;
  widthPct: number;
  /** 1 = the normal fit (page width setting); below shrinks pages, above widens past the screen */
  zoom: number;
  onZoom: (update: (z: number) => number) => void;
}

/** Continuous vertical scrolling (webtoon / long-strip style) with lazy page loading and zoom. */
export function ScrollView({ source, startPage, jump, dims, onDims, onPage, onTap, gap, widthPct, zoom, onZoom }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(rootEl);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const [urls, setUrls] = useState<Map<number, string>>(new Map());
  const wanted = useRef(new Set<number>());
  const currentPage = useRef(startPage);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  // where you are, so zooming keeps the same spot under the reading line
  const anchor = useRef({ page: startPage, frac: 0, xFrac: 0.5 });

  const load = (i: number) => {
    if (i < 0 || i >= source.pageCount || wanted.current.has(i)) return;
    wanted.current.add(i);
    source.pageUrl(i).then((u) => setUrls((m) => new Map(m).set(i, u)), () => {});
  };
  const loadAround = (p: number) => {
    for (let d = -2; d <= 4; d++) load(p + d);
  };

  // Lazy-load pages that come within ~2 screens (plus loadAround from the scroll handler).
  useEffect(() => {
    loadAround(startPage);
    const root = ref.current!;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          load(Number((e.target as HTMLElement).dataset.page));
        }
      },
      { root, rootMargin: '200% 200%' },
    );
    pageEls.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Initial position and explicit jumps (scrubber, bookmarks).
  useEffect(() => {
    pageEls.current[startPage]?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!jump.nonce) return;
    loadAround(jump.page);
    pageEls.current[jump.page]?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  const readingLine = () => ref.current!.clientHeight * 0.35;

  const onScroll = () => {
    const root = ref.current!;
    const top = root.getBoundingClientRect().top;
    const mid = top + readingLine();
    // binary search for the page under the reading line
    let lo = 0;
    let hi = source.pageCount - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      const el = pageEls.current[m];
      if (el && el.getBoundingClientRect().top <= mid) lo = m;
      else hi = m - 1;
    }
    const el = pageEls.current[lo];
    if (el) {
      const r = el.getBoundingClientRect();
      anchor.current = {
        page: lo,
        frac: (mid - r.top) / Math.max(1, r.height),
        xFrac: root.scrollWidth > root.clientWidth ? (root.scrollLeft + root.clientWidth / 2) / root.scrollWidth : 0.5,
      };
    }
    loadAround(lo);
    if (lo !== currentPage.current) {
      currentPage.current = lo;
      onPage(lo);
    }
  };

  // After a zoom change, put the same spot back under the reading line.
  const lastZoom = useRef(zoom);
  useLayoutEffect(() => {
    if (lastZoom.current === zoom) return;
    lastZoom.current = zoom;
    const root = ref.current!;
    const { page, frac, xFrac } = anchor.current;
    const el = pageEls.current[page];
    if (el) root.scrollTop = el.offsetTop + frac * el.offsetHeight - readingLine();
    root.scrollLeft = Math.max(0, xFrac * root.scrollWidth - root.clientWidth / 2);
    loadAround(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Pinch (touch) and Ctrl+wheel / trackpad pinch (desktop). Non-passive so the browser doesn't zoom the whole app.
  useEffect(() => {
    const root = ref.current!;
    let pinch: { dist: number; zoom: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { dist: dist(e.touches), zoom: zoomRef.current };
    };
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const z = pinch.zoom * (dist(e.touches) / pinch.dist);
      onZoom(() => clampZoom(z));
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2 && pinch) {
        pinch = null;
        onZoom((z) => (Math.abs(z - 1) < 0.06 ? 1 : z)); // snap to fit when close
      }
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoom((z) => snap(clampZoom(z * (e.deltaY < 0 ? 1.1 : 0.9)), z));
    };
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end);
    root.addEventListener('touchcancel', end);
    root.addEventListener('wheel', wheel, { passive: false });
    return () => {
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', end);
      root.removeEventListener('wheel', wheel);
    };
  }, [onZoom]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const fitWidth = Math.min(size.w || window.innerWidth, (window.innerWidth * widthPct) / 100);
  const pageWidth = Math.round(fitWidth * zoom);

  return (
    <div
      ref={(el) => {
        ref.current = el;
        setRootEl(el);
      }}
      className="scroll-view"
      onScroll={onScroll}
      onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY, t: Date.now() })}
      onPointerUp={(e) => {
        const d = down.current;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8 && Date.now() - d.t < 400) {
          const r = ref.current!.getBoundingClientRect();
          onTap(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
        }
      }}
    >
      {Array.from({ length: source.pageCount }, (_, i) => {
        const d = dims.get(i);
        const url = urls.get(i);
        return (
          <div
            key={i}
            data-page={i}
            ref={(el) => {
              pageEls.current[i] = el;
            }}
            className="scroll-page"
            style={{ width: pageWidth, aspectRatio: d ? `${d.w} / ${d.h}` : '2 / 3', marginBottom: gap * zoom }}
          >
            {url && (
              <img
                src={url}
                alt={`Page ${i + 1}`}
                draggable={false}
                onLoad={(e) => !d && onDims(i, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export const SCROLL_MIN_ZOOM = 0.25;
export const SCROLL_MAX_ZOOM = 4;
const clampZoom = (z: number) => Math.min(SCROLL_MAX_ZOOM, Math.max(SCROLL_MIN_ZOOM, z));
/** Crossing 100% lands exactly on the fit. */
const snap = (next: number, prev: number) => ((prev < 1 && next > 1) || (prev > 1 && next < 1) || Math.abs(next - 1) < 0.02 ? 1 : next);
export const stepScrollZoom = (z: number, factor: number) => snap(clampZoom(z * factor), z);
