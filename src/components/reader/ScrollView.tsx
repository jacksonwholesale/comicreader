import { useEffect, useRef, useState } from 'react';
import type { ComicSource } from '../../lib/archive';
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
}

/** Continuous vertical scrolling (webtoon / long-strip style) with lazy page loading. */
export function ScrollView({ source, startPage, jump, dims, onDims, onPage, onTap, gap, widthPct }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const [urls, setUrls] = useState<Map<number, string>>(new Map());
  const wanted = useRef(new Set<number>());
  const currentPage = useRef(startPage);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);

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
      { root, rootMargin: '200% 0px' },
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

  const onScroll = () => {
    const root = ref.current!;
    const mid = root.getBoundingClientRect().top + root.clientHeight * 0.35;
    // binary search for the page under the reading line
    let lo = 0;
    let hi = source.pageCount - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      const el = pageEls.current[m];
      if (el && el.getBoundingClientRect().top <= mid) lo = m;
      else hi = m - 1;
    }
    loadAround(lo);
    if (lo !== currentPage.current) {
      currentPage.current = lo;
      onPage(lo);
    }
  };

  return (
    <div
      ref={ref}
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
            style={{ width: `min(100%, ${widthPct}vw)`, aspectRatio: d ? `${d.w} / ${d.h}` : '2 / 3', marginBottom: gap }}
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
