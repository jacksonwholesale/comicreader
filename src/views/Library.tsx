import { CheckCheck, ChevronLeft, CloudDownload, HardDriveDownload, FilePlus2, FolderOpen, FolderPlus, Library as LibraryIcon, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { Comic } from '../db';
import { ACCEPT, IMAGE_ACCEPT } from '../lib/archive';
import { collectFromDirectory, fromFileList } from '../lib/importer';
import { queueImport } from '../lib/importQueue';
import { deleteComics, setFinished, sortComics, statusOf, type SortKey } from '../lib/library';
import { useLibrary } from '../lib/useLibrary';
import { downloadMany, removeDownloads } from '../lib/sync';
import { ComicCard, Cover } from '../components/ComicCard';
import { AddToCollection } from '../components/AddToCollection';

type Filter = 'all' | 'unread' | 'reading' | 'finished' | 'favorites' | 'downloaded' | 'cloud';

interface Props {
  onDetail: (c: Comic) => void;
  onRead: (id: string) => void;
  notify: (msg: string) => void;
}

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['unread', 'Unread'],
  ['reading', 'Reading'],
  ['finished', 'Finished'],
  ['favorites', 'Favorites'],
  ['downloaded', 'Downloaded'],
  ['cloud', 'In Drive only'],
];

export function Library({ onDetail, onRead, notify }: Props) {
  const { comics, progress, loading } = useLibrary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>(() => (sessionStorage.getItem('lib.filter') as Filter) || 'all');
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem('lib.sort') as SortKey) || 'series');
  const [grouped, setGrouped] = useState(() => localStorage.getItem('lib.grouped') === '1');
  const [series, setSeries] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const all = comics ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter((c) => {
      if (series !== null && c.series !== series) return false;
      if (q && ![c.title, c.series, c.writer, c.artist, c.publisher, c.fileName].join(' ').toLowerCase().includes(q)) return false;
      const st = statusOf(progress.get(c.id));
      switch (filter) {
        case 'unread':
        case 'reading':
        case 'finished':
          return st === filter;
        case 'favorites':
          return !!c.favorite;
        case 'downloaded':
          return !!c.hasFile;
        case 'cloud':
          return !c.hasFile;
      }
      return true;
    });
    return sortComics(list, sort, progress);
  }, [all, query, filter, sort, series, progress]);

  const continueReading = useMemo(
    () =>
      sortComics(
        all.filter((c) => statusOf(progress.get(c.id)) === 'reading'),
        'recent',
        progress,
      ).slice(0, 12),
    [all, progress],
  );

  const seriesGroups = useMemo(() => {
    const m = new Map<string, Comic[]>();
    for (const c of visible) m.set(c.series, [...(m.get(c.series) ?? []), c]);
    return [...m.entries()].map(([name, items]) => ({
      name,
      items: sortComics(items, 'series'),
      read: items.filter((c) => statusOf(progress.get(c.id)) === 'finished').length,
    }));
  }, [visible, progress]);

  const selecting = selectMode || selected.size > 0;
  const endSelect = () => {
    setSelected(new Set());
    setSelectMode(false);
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const pickFolder = async () => {
    setMenu(false);
    if ('showDirectoryPicker' in window) {
      try {
        const dir = await (window as any).showDirectoryPicker();
        notify('Scanning folder…');
        queueImport(await collectFromDirectory(dir));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') notify((e as Error).message);
      }
    } else folderInput.current?.click();
  };

  // Downloaded comics open from the device; others stream from Drive.
  const open = (c: Comic) => (c.hasFile || c.driveFileId ? onRead(c.id) : onDetail(c));

  if (loading) return <div className="center-fill"><div className="spinner" /></div>;

  return (
    <div className="view library">
      <header className="view-head">
        {series !== null ? (
          <button className="icon-btn" onClick={() => setSeries(null)} aria-label="Back to all series"><ChevronLeft /></button>
        ) : null}
        <h1>{series ?? 'Library'}</h1>
        <div className="search">
          <Search size={18} />
          <input placeholder="Search title, series, creator…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="icon-btn tiny" onClick={() => setQuery('')} aria-label="Clear search"><X size={16} /></button>}
        </div>
        <div className="menu-wrap">
          <button className="btn primary" onClick={() => setMenu((m) => !m)}><FilePlus2 size={18} /><span className="hide-mobile">Import</span></button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); fileInput.current?.click(); }}><FilePlus2 size={18} /> Comic files…</button>
              <button onClick={pickFolder}><FolderOpen size={18} /> A whole folder…</button>
              <p className="menu-note">CBZ · CBR · CB7 · CBT · PDF · EPUB · ZIP/RAR/7z · folders of images</p>
            </div>
          )}
        </div>
        <input ref={fileInput} type="file" multiple hidden accept={`${ACCEPT},${IMAGE_ACCEPT}`} onChange={(e) => { e.target.files && queueImport(fromFileList(e.target.files)); e.target.value = ''; }} />
        <input ref={folderInput} type="file" hidden {...({ webkitdirectory: '' } as any)} onChange={(e) => { e.target.files && queueImport(fromFileList(e.target.files)); e.target.value = ''; }} />
      </header>

      {!all.length ? (
        <EmptyLibrary onFiles={() => fileInput.current?.click()} onFolder={pickFolder} />
      ) : (
        <>
          {series === null && !query && filter === 'all' && continueReading.length > 0 && (
            <section className="shelf">
              <h2>Continue reading</h2>
              <div className="shelf-row">
                {continueReading.map((c) => (
                  <ComicCard key={c.id} comic={c} progress={progress.get(c.id)} onOpen={() => open(c)} onSelect={() => onDetail(c)} />
                ))}
              </div>
            </section>
          )}

          <div className="toolbar">
            <div className="chips">
              {FILTERS.map(([f, label]) => (
                <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => { setFilter(f); sessionStorage.setItem('lib.filter', f); }}>
                  {label}
                </button>
              ))}
            </div>
            <div className="row gap">
              <button className={`btn small${selecting ? ' on' : ''}`} onClick={() => (selecting ? endSelect() : setSelectMode(true))}>
                {selecting ? 'Done' : 'Select'}
              </button>
              {series === null && (
                <div className="segmented compact">
                  <button className={!grouped ? 'on' : ''} onClick={() => { setGrouped(false); localStorage.setItem('lib.grouped', '0'); }}>Issues</button>
                  <button className={grouped ? 'on' : ''} onClick={() => { setGrouped(true); localStorage.setItem('lib.grouped', '1'); }}>Series</button>
                </div>
              )}
              <select className="select" value={sort} onChange={(e) => { setSort(e.target.value as SortKey); localStorage.setItem('lib.sort', e.target.value); }} aria-label="Sort">
                <option value="series">Series & issue</option>
                <option value="recent">Recently read</option>
                <option value="added">Recently added</option>
                <option value="title">Title</option>
                <option value="year">Year</option>
              </select>
            </div>
          </div>

          {grouped && series === null ? (
            <div className="grid">
              {seriesGroups.map((g) => (
                <button key={g.name} className="card series-card" onClick={() => setSeries(g.name)}>
                  <div className="card-cover stack">
                    {g.items.slice(0, 3).reverse().map((c, i, arr) => (
                      <Cover key={c.id} comic={c} className={`stack-${arr.length - 1 - i}`} />
                    ))}
                  </div>
                  <div className="card-meta">
                    <strong>{g.name}</strong>
                    <span>{g.items.length} issue{g.items.length === 1 ? '' : 's'} · {g.read} read</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid">
              {visible.map((c) => (
                <ComicCard
                  key={c.id}
                  comic={c}
                  progress={progress.get(c.id)}
                  selecting={selecting}
                  selected={selected.has(c.id)}
                  onOpen={() => open(c)}
                  onSelect={() => (selecting ? toggle(c.id) : onDetail(c))}
                />
              ))}
            </div>
          )}
          {!visible.length && <p className="muted center pad">Nothing matches.</p>}
        </>
      )}

      {selecting && (
        <div className="selection-bar">
          <span><strong>{selected.size}</strong> selected</span>
          <button className="btn small ghost" onClick={() => setSelected(new Set(visible.map((c) => c.id)))}>All</button>
          <button className="btn small" onClick={() => setAdding(true)}><FolderPlus size={16} /> <span className="hide-mobile">Collection</span></button>
          <button className="btn small" title="Download for offline reading" onClick={() => { void downloadMany([...selected]); notify('Downloading for offline reading…'); endSelect(); }}>
            <CloudDownload size={16} /> <span className="hide-mobile">Download</span>
          </button>
          <button
            className="btn small"
            title="Remove downloads (stay in Drive)"
            onClick={() => void removeDownloads([...selected]).then((n) => { notify(n ? `Freed space from ${n} comic(s) — still in Drive` : 'Nothing to remove: only comics stored in Drive can be removed from the device'); endSelect(); })}
          >
            <HardDriveDownload size={16} /> <span className="hide-mobile">Remove</span>
          </button>
          <button className="btn small" onClick={() => void setFinished([...selected], true).then(endSelect)}><CheckCheck size={16} /> <span className="hide-mobile">Read</span></button>
          <button className="btn small" onClick={() => void setFinished([...selected], false).then(endSelect)}><RotateCcw size={16} /> <span className="hide-mobile">Unread</span></button>
          <button
            className="btn small danger"
            onClick={() => {
              if (confirm(`Delete ${selected.size} comic(s) from your library on all devices?`)) void deleteComics([...selected]).then(endSelect);
            }}
          >
            <Trash2 size={16} />
          </button>
          <button className="icon-btn" onClick={endSelect} aria-label="Cancel selection"><X /></button>
        </div>
      )}
      {adding && <AddToCollection comicIds={[...selected]} onClose={() => { setAdding(false); endSelect(); }} notify={notify} />}
    </div>
  );
}

function EmptyLibrary({ onFiles, onFolder }: { onFiles: () => void; onFolder: () => void }) {
  return (
    <div className="empty">
      <LibraryIcon size={48} strokeWidth={1.3} />
      <h2>Your shelves are empty</h2>
      <p className="muted">Drop comics anywhere on this window, or pick files or a whole folder. Everything stays on this device unless you turn on Google Drive sync.</p>
      <div className="row gap center">
        <button className="btn primary" onClick={onFiles}><FilePlus2 size={18} /> Add comic files</button>
        <button className="btn" onClick={onFolder}><FolderOpen size={18} /> Add a folder</button>
      </div>
      <p className="muted small">CBZ · CBR · CB7 · CBT · PDF · EPUB · ZIP/RAR/7z/TAR · folders of JPG/PNG/WebP/AVIF images</p>
    </div>
  );
}
