import { Bookmark, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ComicSource } from '../../lib/archive';

interface Props {
  source: ComicSource;
  current: number;
  bookmarks: number[];
  onPick: (page: number) => void;
  onClose: () => void;
}

export function PageGrid({ source, current, bookmarks, onPick, onClose }: Props) {
  const [onlyBookmarks, setOnlyBookmarks] = useState(false);
  const pages = onlyBookmarks ? bookmarks : Array.from({ length: source.pageCount }, (_, i) => i);
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => currentRef.current?.scrollIntoView({ block: 'center' }), []);
  return (
    <div className="sheet page-grid-sheet" onPointerDown={(e) => e.stopPropagation()}>
      <div className="sheet-head">
        <h3>Pages</h3>
        <div className="segmented compact">
          <button className={!onlyBookmarks ? 'on' : ''} onClick={() => setOnlyBookmarks(false)}>All</button>
          <button className={onlyBookmarks ? 'on' : ''} onClick={() => setOnlyBookmarks(true)}>Bookmarks ({bookmarks.length})</button>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="page-grid">
        {pages.map((p) => (
          <button key={p} ref={p === current ? currentRef : undefined} className={`thumb${p === current ? ' current' : ''}`} onClick={() => onPick(p)}>
            <LazyThumb source={source} page={p} />
            <span>{p + 1}</span>
            {bookmarks.includes(p) && <Bookmark className="thumb-mark" size={16} />}
          </button>
        ))}
        {onlyBookmarks && !bookmarks.length && <p className="muted">No bookmarks yet — tap the bookmark icon while reading.</p>}
      </div>
    </div>
  );
}

function LazyThumb({ source, page }: { source: ComicSource; page: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        io.disconnect();
        source.pageUrl(page).then(setUrl, () => {});
      }
    });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, [source, page]);
  return <div ref={ref} className="thumb-img">{url && <img src={url} alt="" loading="lazy" />}</div>;
}
