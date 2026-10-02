import { useEffect, useState, useSyncExternalStore } from 'react';

/** Object URL for a Blob, revoked automatically. */
export function useBlobUrl(blob?: Blob | null) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** Hash-based routing: works from file://, GitHub Pages, and as an installed PWA. */
function readHash() {
  return location.hash.replace(/^#\/?/, '') || '';
}
export function useRoute(): string[] {
  const hash = useSyncExternalStore(
    (fn) => {
      window.addEventListener('hashchange', fn);
      return () => window.removeEventListener('hashchange', fn);
    },
    readHash,
  );
  return hash.split('/').filter(Boolean).map(decodeURIComponent);
}
export function go(path: string) {
  location.hash = `#/${path}`;
}

export function useElementSize(el: HTMLElement | null) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    // measure immediately; ResizeObserver only reports on the next rendered frame
    const r = el.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return size;
}

export function useMediaQuery(q: string) {
  return useSyncExternalStore(
    (fn) => {
      const m = matchMedia(q);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => matchMedia(q).matches,
  );
}
