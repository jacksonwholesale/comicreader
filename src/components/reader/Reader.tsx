import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  Columns2,
  Grid3x3,
  Maximize,
  RectangleVertical,
  ScanSearch,
  Rows3,
  Settings2,
  ArrowLeftRight,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { db, type Comic, type Direction, type ReadMode } from '../../db';
import type { ComicSource } from '../../lib/archive';
import { applySourceInfo } from '../../lib/importer';
import { openForReading } from '../../lib/remote';
import { useElementSize } from '../../lib/hooks';
import { nextInSeries, saveProgress, startSession, toggleBookmark, updateComic } from '../../lib/library';
import { contentBox, detectPanels, type Rect } from '../../lib/panels';
import { setPrefs, usePrefs } from '../../lib/prefs';
import { syncNow } from '../../lib/sync';
import { device } from '../../lib/syncState';
import { buildSpreads, layoutPage, type Dims } from './layout';
import { PageImage } from './PageImage';
import { ReaderSettings } from './ReaderSettings';
import { ScrollView, stepScrollZoom } from './ScrollView';
import { PageGrid } from './PageGrid';

interface Props {
  comicId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}

type Zoom = { s: number; tx: number; ty: number; animate?: boolean };
const NO_ZOOM: Zoom = { s: 1, tx: 0, ty: 0 };
// 1 = your page-fit setting; you can zoom out below it (page centred) or in above it.
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const isFit = (z: Zoom) => Math.abs(z.s - 1) < 0.01;
type Leaving = { view: number[]; kind: 'turn' | 'fade'; forward: boolean; key: number };

export function Reader({ comicId, onClose, onOpen }: Props) {
  const prefs = usePrefs();
  const comic = useLiveQuery(() => db.comics.get(comicId), [comicId]);
  const progress = useLiveQuery(() => db.progress.get(comicId), [comicId]);
  const allComics = useLiveQuery(() => db.comics.filter((c) => !c.deleted).toArray(), []);

  const [source, setSource] = useState<ComicSource | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState<{ streaming: boolean; progress?: number; text?: string }>({ streaming: false });
  const [page, setPage] = useState<number | null>(null); // anchor page (first page of the current view)
  const [ui, setUi] = useState(false);
  const [panel, setPanel] = useState<'none' | 'settings' | 'pages'>('none');
  const [urls, setUrls] = useState<Map<number, string>>(new Map());
  const [failed, setFailed] = useState<Set<number>>(new Set()); // pages that couldn't be drawn
  const [dims, setDims] = useState<Map<number, Dims>>(new Map());
  const [crops, setCrops] = useState<Map<number, Rect | null>>(new Map());
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const [scrollZoom, setScrollZoom] = useState(1); // scroll mode: 1 = page-width fit
  const [drag, setDrag] = useState(0);
  const [trackAnim, setTrackAnim] = useState(false);
  const [slide, setSlide] = useState<{ to: number; dir: number } | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [atEnd, setAtEnd] = useState(false);
  const [jump, setJump] = useState({ page: 0, nonce: 0 });
  const [remoteHint, setRemoteHint] = useState<{ page: number; device: string } | null>(null);
  const [panels, setPanels] = useState<Map<number, Rect[]>>(new Map());
  const [step, setStep] = useState(0); // guided-view step within page
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const box = useElementSize(stageEl);
  const openedAt = useRef(Date.now());
  const session = useRef<ReturnType<typeof startSession> | null>(null);

  const mode: ReadMode = comic?.readMode ?? prefs.readMode;
  const direction: Direction = comic?.direction ?? (prefs.autoMangaDirection && comic?.mangaHint ? 'rtl' : prefs.direction);
  const sideSign = direction === 'ltr' ? 1 : -1;

  // ---- open the file ----
  useEffect(() => {
    let src: ComicSource | null = null;
    let cancelled = false;
    (async () => {
      const c = await db.comics.get(comicId);
      if (!c) throw new Error('Comic not found.');
      if (!c.hasFile) setLoading({ streaming: true, progress: undefined });
      src = await openForReading(
        c,
        (progress) => setLoading({ streaming: true, progress }),
        (text) => setLoading({ streaming: true, text }),
      );
      if (cancelled) return src.close();
      if (src.pageCount === 0) throw new Error('No pages found in this file.');
      // page count, ComicInfo and covers for comics only known from Drive so far
      void applySourceInfo(c.id, src);
      const p = await db.progress.get(comicId);
      const start = p && !p.finished ? Math.min(p.page, src.pageCount - 1) : 0;
      setSource(src);
      setPage(start);
      setJump({ page: start, nonce: 0 });
      session.current = startSession(comicId, start);
    })().catch((e) => setError((e as Error).message));
    void syncNow(); // pull the latest position from other devices
    return () => {
      cancelled = true;
      src?.close();
      session.current?.end();
      session.current = null;
      void syncNow();
    };
  }, [comicId]);

  // Offer to jump if another device moved ahead while we're open.
  useEffect(() => {
    if (!progress || page === null || !progress.device || progress.device === device.name) return;
    if (progress.updatedAt > openedAt.current && progress.page !== page) setRemoteHint({ page: progress.page, device: progress.device });
  }, [progress, page]);

  // ---- views (what is on screen together) ----
  const pageCount = source?.pageCount ?? 0;
  const views = useMemo<number[][]>(() => {
    if (!pageCount) return [];
    if (mode === 'double') return buildSpreads(pageCount, dims, prefs.doubleCoverAlone);
    return Array.from({ length: pageCount }, (_, i) => [i]);
  }, [pageCount, mode, dims, prefs.doubleCoverAlone]);
  const vi = page === null ? -1 : Math.max(0, views.findIndex((v) => v.includes(page)));
  const view = views[vi] ?? [];
  const lastVisible = view[view.length - 1] ?? page ?? 0;

  // ---- load nearby pages, dimensions, crops ----
  useEffect(() => {
    if (!source || page === null || mode === 'scroll') return;
    const near = new Set<number>();
    for (let d = -2; d <= 3; d++) (views[vi + d] ?? []).forEach((p) => near.add(p));
    for (const p of near) {
      if (urls.has(p)) continue;
      source.pageUrl(p).then((u) => {
        setUrls((m) => (m.has(p) ? m : new Map(m).set(p, u)));
        if (prefs.autoCrop && !crops.has(p)) contentBox(u).then((r) => setCrops((m) => new Map(m).set(p, r)), () => {});
      }, () => setFailed((f) => new Set(f).add(p)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, vi, views, mode, prefs.autoCrop]);

  const onDims = useCallback((p: number, d: Dims) => setDims((m) => (m.get(p)?.w === d.w && m.get(p)?.h === d.h ? m : new Map(m).set(p, d))), []);

  // ---- persist progress ----
  useEffect(() => {
    if (!comic || page === null) return;
    session.current?.page(lastVisible);
    const t = setTimeout(() => void saveProgress({ ...comic, pageCount: source?.pageCount || comic.pageCount }, lastVisible), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastVisible, comic?.id]);

  // ---- guided view: panels for the current page ----
  useEffect(() => {
    if (mode !== 'guided' || page === null) return;
    // this page, plus the next one so the hand-off between pages is instant
    for (const p of [page, page + 1]) {
      const u = urls.get(p);
      if (!u || panels.has(p)) continue;
      detectPanels(u, direction).then(
        (r) => setPanels((m) => new Map(m).set(p, r.rects)),
        () => setPanels((m) => new Map(m).set(p, [])),
      );
    }
  }, [mode, page, urls, panels, direction]);
  const guidedSteps = useMemo(() => {
    if (mode !== 'guided' || page === null) return [] as (Rect | null)[];
    const ps = panels.get(page) ?? [];
    return prefs.guidedShowFullPageFirst || !ps.length ? [null, ...ps] : ps;
  }, [mode, page, panels, prefs.guidedShowFullPageFirst]);
  useEffect(() => {
    if (step === -1 && guidedSteps.length && panels.has(page ?? -1)) setStep(guidedSteps.length - 1);
  }, [step, guidedSteps, panels, page]);

  // Guided zoom transform: frame the current panel.
  useEffect(() => {
    if (mode !== 'guided' || page === null) return;
    const r = guidedSteps[step];
    if (!r || !box.w) return setZoom({ ...NO_ZOOM, animate: true });
    const { w: pw, h: ph } = layoutPage(dims.get(page), null, 'screen', box.w, box.h);
    const ox = (box.w - pw) / 2;
    const oy = (box.h - ph) / 2;
    const rx = ox + r.x * pw;
    const ry = oy + r.y * ph;
    const s = Math.min(4, Math.min(box.w / (r.w * pw), box.h / (r.h * ph)) * 0.97);
    setZoom({ s, tx: box.w / 2 - s * (rx + (r.w * pw) / 2), ty: box.h / 2 - s * (ry + (r.h * ph) / 2), animate: true });
  }, [mode, page, step, guidedSteps, box.w, box.h, dims]);

  // ---- navigation ----
  const goView = useCallback(
    (target: number, opts: { animate?: boolean; guidedStep?: number } = {}) => {
      if (!views.length) return;
      if (target >= views.length) {
        setAtEnd(true);
        setUi(false);
        if (comic && source) void saveProgress({ ...comic, pageCount: source.pageCount }, source.pageCount - 1);
        return;
      }
      if (target < 0) return;
      const delta = target - vi;
      setZoom(NO_ZOOM);
      setStep(opts.guidedStep ?? 0);
      const animate = opts.animate !== false && Math.abs(delta) === 1 && mode !== 'guided';
      if (animate && prefs.transition === 'slide') {
        setTrackAnim(true);
        setSlide({ to: target, dir: delta });
        return;
      }
      if (animate && (prefs.transition === 'turn' || prefs.transition === 'fade')) {
        setLeaving({ view, kind: prefs.transition, forward: delta > 0, key: Date.now() });
      }
      setDrag(0);
      setPage(views[target][0]);
    },
    [views, vi, view, mode, prefs.transition, comic, source],
  );

  const next = useCallback(() => {
    if (mode === 'guided' && step < guidedSteps.length - 1) return setStep((s) => s + 1);
    goView(vi + 1);
  }, [mode, step, guidedSteps.length, goView, vi]);

  const prev = useCallback(() => {
    if (mode === 'guided' && step > 0) return setStep((s) => s - 1);
    goView(vi - 1, { guidedStep: mode === 'guided' ? -1 : 0 });
  }, [mode, step, goView, vi]);

  const physical = useCallback((side: 'left' | 'right') => ((side === 'right') === (direction === 'ltr') ? next() : prev()), [direction, next, prev]);

  const jumpTo = (p: number) => {
    setAtEnd(false);
    if (mode === 'scroll') {
      setPage(p);
      setJump({ page: p, nonce: Date.now() });
    } else goView(Math.max(0, views.findIndex((v) => v.includes(p))), { animate: false });
  };

  // Finish the slide animation, then commit the new page.
  useEffect(() => {
    if (!slide) return;
    const t = setTimeout(() => {
      setTrackAnim(false);
      setPage(views[slide.to]?.[0] ?? page);
      setSlide(null);
      setDrag(0);
    }, 230);
    return () => clearTimeout(t);
  }, [slide, views, page]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (panel !== 'none' && e.key !== 'Escape') return;
      switch (e.key) {
        case 'ArrowRight':
          mode !== 'scroll' && physical('right');
          break;
        case 'ArrowLeft':
          mode !== 'scroll' && physical('left');
          break;
        case ' ':
        case 'PageDown':
          if (mode === 'scroll') return;
          e.preventDefault();
          e.shiftKey ? prev() : next();
          break;
        case 'PageUp':
          mode !== 'scroll' && prev();
          break;
        case 'Home':
          jumpTo(0);
          break;
        case 'End':
          jumpTo(pageCount - 1);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
        case 'Enter':
          setUi((u) => !u);
          break;
        case 'b':
          if (progress) void toggleBookmark(comicId, lastVisible);
          break;
        case '+':
        case '=':
          if (mode === 'scroll') setScrollZoom((z) => stepScrollZoom(z, 1.25));
          else setZoom((z) => zoomAt(z, 1.25, box.w / 2, box.h / 2, box));
          break;
        case '-':
          if (mode === 'scroll') setScrollZoom((z) => stepScrollZoom(z, 0.8));
          else setZoom((z) => zoomAt(z, 0.8, box.w / 2, box.h / 2, box));
          break;
        case '0':
          if (mode === 'scroll') setScrollZoom(1);
          else setZoom(NO_ZOOM);
          break;
        case 'Escape':
          if (panel !== 'none') setPanel('none');
          else if (document.fullscreenElement) void document.exitFullscreen();
          else onClose();
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- keep the screen awake while reading ----
  useEffect(() => {
    if (!prefs.keepAwake || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => navigator.wakeLock.request('screen').then((l) => (lock = l), () => {});
    acquire();
    const onVis = () => document.visibilityState === 'visible' && acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [prefs.keepAwake]);

  // ---- gestures (paged / double / guided) ----
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    x: number; y: number; t: number; kind: 'none' | 'swipe' | 'pan' | 'pinch';
    z: Zoom; dist: number; mx: number; my: number;
  } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<number>(undefined);

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = stageEl!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = rel(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2 && mode !== 'guided') {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { x: p.x, y: p.y, t: Date.now(), kind: 'pinch', z: zoom, dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else if (pointers.current.size === 1) {
      gesture.current = { x: p.x, y: p.y, t: Date.now(), kind: 'none', z: zoom, dist: 0, mx: 0, my: 0 };
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const p = rel(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g.kind === 'pinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / (g.dist || 1);
      const s = clamp(g.z.s * ratio, MIN_ZOOM, MAX_ZOOM);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      setZoom(clampZoom({ s, tx: mx - (g.mx - g.z.tx) * (s / g.z.s), ty: my - (g.my - g.z.ty) * (s / g.z.s) }, box));
      return;
    }
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    if (g.kind === 'none' && Math.hypot(dx, dy) > 10) g.kind = zoom.s > 1.01 && mode !== 'guided' ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'none';
    if (g.kind === 'pan') setZoom(clampZoom({ s: g.z.s, tx: g.z.tx + dx, ty: g.z.ty + dy }, box));
    if (g.kind === 'swipe' && prefs.transition === 'slide' && mode !== 'guided') {
      // resist at the ends
      const atStart = vi === 0 && dx * sideSign > 0;
      setTrackAnim(false);
      setDrag(atStart ? dx / 3 : dx);
    }
  };

  const onPointerUp = (e: RPointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pointers.current.size === 0) {
        gesture.current = null;
        if (Math.abs(zoom.s - 1) < 0.06) setZoom({ ...NO_ZOOM, animate: true }); // snap back to fit when close
      }
      return;
    }
    gesture.current = null;
    const p = rel(e);
    const dx = p.x - g.x;
    const dt = Date.now() - g.t;
    if (g.kind === 'swipe') {
      if (Math.abs(dx) > Math.min(80, box.w * 0.15) || (Math.abs(dx) > 30 && dt < 250)) physical(dx < 0 ? 'right' : 'left');
      else {
        setTrackAnim(true);
        setDrag(0);
      }
      return;
    }
    if (g.kind === 'none' && Math.hypot(dx, p.y - g.y) < 10 && dt < 400) handleTap(p.x, p.y);
  };

  const handleTap = (x: number, y: number) => {
    if (panel !== 'none') return setPanel('none');
    if (atEnd) return;
    const zone = tapZone(x, y, box.w, box.h, prefs.tapZones);
    const side = zone === 'center' ? 'center' : prefs.invertTaps ? (zone === 'left' ? 'right' : 'left') : zone;
    if (side !== 'center' && !ui && mode !== 'scroll') {
      if (zoom.s > 1.01 && mode !== 'guided') return; // while zoomed, taps don't turn pages
      return physical(side);
    }
    // center: single tap toggles UI, double tap zooms
    const now = Date.now();
    if (now - lastTap.current < 280 && mode !== 'scroll' && mode !== 'guided') {
      clearTimeout(tapTimer.current);
      lastTap.current = 0;
      setZoom((z) => (!isFit(z) ? { ...NO_ZOOM, animate: true } : { ...zoomAt(z, 2.5, x, y, box), animate: true }));
      return;
    }
    lastTap.current = now;
    clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => setUi((u) => !u), mode === 'scroll' || mode === 'guided' ? 0 : 230);
  };

  const onWheel = (e: RWheelEvent) => {
    if (mode === 'scroll') return;
    if (e.ctrlKey) {
      const p = rel(e);
      setZoom((z) => zoomAt(z, e.deltaY < 0 ? 1.15 : 0.87, p.x, p.y, box));
      return;
    }
    const slot = (e.target as HTMLElement).closest('.spread') as HTMLElement | null;
    if (slot && slot.scrollHeight > slot.clientHeight + 2) {
      const atBottom = slot.scrollTop + slot.clientHeight >= slot.scrollHeight - 2;
      const atTop = slot.scrollTop <= 0;
      if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;
    }
    if (zoom.s > 1.01) return setZoom((z) => clampZoom({ ...z, ty: z.ty - e.deltaY, tx: z.tx - e.deltaX }, box));
    const now = Date.now();
    if (now - wheelAt.current < 350 || Math.abs(e.deltaY) < 20) return;
    wheelAt.current = now;
    e.deltaY > 0 ? next() : prev();
  };
  const wheelAt = useRef(0);

  // reset slot scroll on page change (fit width / original)
  useEffect(() => {
    stageEl?.querySelectorAll('.spread').forEach((s) => (s.scrollTop = 0));
  }, [page, stageEl]);

  if (error)
    return (
      <div className="reader reader-error">
        <p>{error}</p>
        <button className="btn" onClick={onClose}>Back to library</button>
      </div>
    );
  if (!comic || !source || page === null)
    return (
      <div className="reader reader-loading">
        <div className="spinner" />
        {loading.streaming && (
          <p>
            {loading.text ??
              (loading.progress === undefined ? 'Opening from Google Drive…' : `Loading from Google Drive… ${Math.round(loading.progress * 100)}%`)}
          </p>
        )}
        <button className="btn ghost small" onClick={onClose}>Cancel</button>
      </div>
    );

  const bookmarked = progress?.bookmarks.includes(lastVisible);
  const crop = (p: number) => (prefs.autoCrop && mode !== 'guided' ? crops.get(p) : null);
  const renderView = (v: number[]) => {
    const spread = v.length === 2;
    const ordered = direction === 'rtl' ? [...v].reverse() : v;
    const fit = mode === 'guided' ? 'screen' : prefs.fit;
    return (
      <div className="spread">
        {ordered.map((p) => (
          <PageImage
            key={p}
            url={urls.get(p)}
            failed={failed.has(p)}
            dims={dims.get(p)}
            crop={crop(p)}
            fit={fit}
            boxW={spread ? box.w / 2 : box.w}
            boxH={box.h}
            onDims={(d) => onDims(p, d)}
          />
        ))}
      </div>
    );
  };

  const next1 = views[vi + 1];
  const prev1 = views[vi - 1];
  const slideOffset = slide ? -slide.dir * sideSign * box.w : drag;
  const upNext = allComics && nextInSeries(comic, allComics);
  const contentStyle = {
    transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})`,
    transition: zoom.animate ? 'transform 320ms cubic-bezier(.2,.8,.2,1)' : 'none',
  };
  const filter = prefs.brightness !== 100 ? `brightness(${prefs.brightness / 100})` : undefined;

  const pageLabel = `${mode === 'guided' && guidedSteps.length > 1 ? `Panel ${step + 1}/${guidedSteps.length} · ` : ''}${
    view.length === 2 && mode !== 'scroll' ? `Pages ${view[0] + 1}–${view[1] + 1}` : `Page ${(mode === 'scroll' ? page : lastVisible) + 1}`
  } of ${pageCount}`;

  // − Fit/% + (top bar on desktop, bottom bar on phones); scroll mode zooms page width instead
  const zoomLevel = mode === 'scroll' ? scrollZoom : zoom.s;
  const atFit = Math.abs(zoomLevel - 1) < 0.01;
  const zoomStep = (f: number) =>
    mode === 'scroll' ? setScrollZoom((z) => stepScrollZoom(z, f)) : setZoom((z) => ({ ...zoomAt(z, f, box.w / 2, box.h / 2, box), animate: true }));
  const zoomUi =
    mode === 'guided' ? null : (
      <div className="zoom-controls">
        <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomStep(0.8)}>
          <ZoomOut />
        </button>
        <button className="zoom-pct" title="Back to page fit (0)" onClick={() => (mode === 'scroll' ? setScrollZoom(1) : setZoom({ ...NO_ZOOM, animate: true }))}>
          {atFit ? 'Fit' : `${Math.round(zoomLevel * 100)}%`}
        </button>
        <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomStep(1.25)}>
          <ZoomIn />
        </button>
      </div>
    );

  return (
    <div className={`reader bg-${prefs.background}`}>
      {mode === 'scroll' ? (
        <div className="stage" ref={setStageEl} style={{ filter }}>
          <ScrollView
            source={source}
            startPage={page}
            jump={jump}
            dims={dims}
            onDims={onDims}
            onPage={(p) => setPage(p)}
            onTap={(x, y, w, h) => (tapZone(x, y, w, h, 'edges') === 'center' || ui ? setUi((u) => !u) : undefined)}
            gap={prefs.scrollGap}
            widthPct={prefs.scrollWidth}
            zoom={scrollZoom}
            onZoom={setScrollZoom}
          />
        </div>
      ) : (
        <div
          className="stage"
          ref={setStageEl}
          style={{ filter, touchAction: zoom.s > 1.01 || mode === 'guided' || prefs.fit === 'screen' || prefs.fit === 'height' ? 'none' : 'pan-y' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            gesture.current = null;
            setDrag(0);
          }}
          onWheel={onWheel}
        >
          <div className="track" style={{ transform: `translateX(${slideOffset}px)`, transition: trackAnim ? 'transform 220ms ease-out' : 'none' }}>
            {prev1 && (
              <div key={`v${prev1[0]}`} className="slot" style={{ transform: `translateX(${-sideSign * 100}%)` }}>
                <div className="zoom-layer">{renderView(prev1)}</div>
              </div>
            )}
            <div key={`v${view[0]}`} className="slot current">
              <div className="zoom-layer" style={contentStyle}>{renderView(view)}</div>
            </div>
            {next1 && (
              <div key={`v${next1[0]}`} className="slot" style={{ transform: `translateX(${sideSign * 100}%)` }}>
                <div className="zoom-layer">{renderView(next1)}</div>
              </div>
            )}
          </div>
          {leaving && (
            <div
              key={leaving.key}
              className={`slot leaving ${leaving.kind} ${(leaving.forward ? 1 : -1) * sideSign > 0 ? 'to-left' : 'to-right'}`}
              onAnimationEnd={() => setLeaving(null)}
            >
              {renderView(leaving.view)}
            </div>
          )}
        </div>
      )}

      {prefs.warmth > 0 && <div className="warmth" style={{ opacity: (prefs.warmth / 100) * 0.45 }} />}

      {prefs.alwaysShowPageNumber && !ui && !atEnd && <div className="page-badge">{pageLabel}</div>}

      {remoteHint && (
        <div className="toast reader-toast">
          <span>Page {remoteHint.page + 1} on {remoteHint.device}</span>
          <button className="btn small primary" onClick={() => { jumpTo(remoteHint.page); setRemoteHint(null); }}>Jump</button>
          <button className="btn small ghost" onClick={() => setRemoteHint(null)}>Stay</button>
        </div>
      )}

      {ui && (
        <>
          <header className="reader-top">
            <button className="icon-btn" onClick={onClose} aria-label="Back"><ArrowLeft /></button>
            <div className="reader-title">
              <strong>{comic.title}</strong>
              <span>{comic.series}{comic.number ? ` #${comic.number}` : ''}</span>
            </div>
            <div className="hide-mobile">{zoomUi}</div>
            <button className="icon-btn" aria-label="Bookmark" onClick={() => void toggleBookmark(comicId, lastVisible)}>
              {bookmarked ? <BookmarkCheck className="accent" /> : <Bookmark />}
            </button>
            <button className="icon-btn" aria-label="Pages" onClick={() => setPanel(panel === 'pages' ? 'none' : 'pages')}><Grid3x3 /></button>
            <button className="icon-btn" aria-label="Reader settings" onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')}><Settings2 /></button>
            <button className="icon-btn hide-mobile" aria-label="Fullscreen" onClick={toggleFullscreen}><Maximize /></button>
          </header>
          <footer className="reader-bottom">
            <div className="page-label">{pageLabel}</div>
            {zoomUi && <div className="show-mobile zoom-row">{zoomUi}</div>}
            <div className="scrubber" dir={direction}>
              <span>{lastVisible + 1}</span>
              <input
                type="range"
                min={0}
                max={pageCount - 1}
                value={mode === 'scroll' ? page : lastVisible}
                onChange={(e) => jumpTo(Number(e.target.value))}
                aria-label="Page"
              />
              <span>{pageCount}</span>
            </div>
            <div className="mode-bar">
              {(
                [
                  ['paged', RectangleVertical, 'Single'],
                  ['double', Columns2, 'Double'],
                  ['scroll', Rows3, 'Scroll'],
                  ['guided', ScanSearch, 'Panels'],
                ] as const
              ).map(([m, Icon, label]) => (
                <button key={m} className={`seg${mode === m ? ' on' : ''}`} onClick={() => void updateComic(comicId, { readMode: m })}>
                  <Icon size={18} />
                  <span>{label}</span>
                </button>
              ))}
              <button
                className="seg"
                disabled={mode === 'scroll'}
                onClick={() => void updateComic(comicId, { direction: direction === 'ltr' ? 'rtl' : 'ltr' })}
                title="Reading direction"
              >
                <ArrowLeftRight size={18} />
                <span>{direction === 'ltr' ? 'L→R' : 'R→L'}</span>
              </button>
            </div>
          </footer>
        </>
      )}

      {panel === 'settings' && (
        <ReaderSettings
          comic={comic}
          mode={mode}
          direction={direction}
          onClose={() => setPanel('none')}
          onMakeDefault={() => setPrefs({ readMode: mode, direction })}
        />
      )}
      {panel === 'pages' && (
        <PageGrid
          source={source}
          current={lastVisible}
          bookmarks={progress?.bookmarks ?? []}
          onPick={(p) => {
            jumpTo(p);
            setPanel('none');
          }}
          onClose={() => setPanel('none')}
        />
      )}

      {atEnd && (
        <EndCard
          comic={comic}
          upNext={upNext}
          onBack={onClose}
          onRestart={() => {
            setAtEnd(false);
            jumpTo(0);
          }}
          onDismiss={() => setAtEnd(false)}
          onNext={(c) => onOpen(c.id)}
        />
      )}
    </div>
  );
}

function EndCard({ comic, upNext, onBack, onRestart, onDismiss, onNext }: {
  comic: Comic; upNext?: Comic; onBack: () => void; onRestart: () => void; onDismiss: () => void; onNext: (c: Comic) => void;
}) {
  return (
    <div className="end-card" onClick={onDismiss}>
      <div className="end-inner" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Finished</p>
        <h2>{comic.title}</h2>
        {upNext && (
          <button className="up-next" onClick={() => (upNext.hasFile ? onNext(upNext) : onBack())}>
            <span className="eyebrow">Up next in {upNext.series}</span>
            <strong>{upNext.title}</strong>
            {!upNext.hasFile && <span className="muted">Not downloaded — open it from the library</span>}
          </button>
        )}
        <div className="row gap">
          <button className="btn" onClick={onRestart}>Read again</button>
          <button className="btn primary" onClick={onBack}>Back to library</button>
        </div>
      </div>
    </div>
  );
}

function tapZone(x: number, y: number, w: number, h: number, zones: 'edges' | 'halves' | 'off'): 'left' | 'right' | 'center' {
  if (zones === 'off') return 'center';
  const fx = x / w;
  if (zones === 'halves') {
    if (fx > 0.4 && fx < 0.6 && y / h > 0.3 && y / h < 0.7) return 'center';
    return fx < 0.5 ? 'left' : 'right';
  }
  return fx < 0.3 ? 'left' : fx > 0.7 ? 'right' : 'center';
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function clampZoom(z: Zoom, box: { w: number; h: number }): Zoom {
  // Zoomed out: keep the page centred. Zoomed in: keep it covering the screen while panning.
  const axis = (t: number, size: number) => (z.s <= 1 ? (size - size * z.s) / 2 : clamp(t, size - size * z.s, 0));
  return { ...z, tx: axis(z.tx, box.w), ty: axis(z.ty, box.h), animate: false };
}

function zoomAt(z: Zoom, factor: number, x: number, y: number, box: { w: number; h: number }): Zoom {
  let s = clamp(z.s * factor, MIN_ZOOM, MAX_ZOOM);
  // stepping across 100% lands exactly on the fit
  if ((z.s < 1 && s > 1) || (z.s > 1 && s < 1) || Math.abs(s - 1) < 0.02) s = 1;
  if (s === 1) return NO_ZOOM;
  return clampZoom({ s, tx: x - (x - z.tx) * (s / z.s), ty: y - (y - z.ty) * (s / z.s) }, box);
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}
