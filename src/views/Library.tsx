import { BookOpen, CheckCheck, FolderInput, Pencil, ChevronLeft, Info, ChevronRight, CloudDownload, HardDriveDownload, FilePlus2, FolderOpen, FolderPlus, Library as LibraryIcon, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { Comic } from '../db';
import { ACCEPT, IMAGE_ACCEPT } from '../lib/archive';
import { collectFromDirectory, fromFileList } from '../lib/importer';
import { queueImport } from '../lib/importQueue';
import { deleteComics, isReadable, removeFromContinueReading, setFinished, setShelves, sortComics, statusOf, type SortKey } from '../lib/library';
import { useLibrary } from '../lib/useLibrary';
import { allGroups, buildTree, findPath, shownPaths, type FolderNode } from '../lib/folders';
import { TextPrompt } from '../components/TextPrompt';
import { MoveDialog } from '../components/MoveDialog';
import { computeUpNext, upNextKey } from '../lib/upNext';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs';
import { downloadMany, removeDownloads } from '../lib/sync';
import { ComicCard, Cover } from '../components/ComicCard';
import { AddToCollection } from '../components/AddToCollection';
import { ContextMenu } from '../components/ContextMenu';
import { CollectionsGrid } from './Collections';
import type { Notify } from '../App';

type Filter = 'all' | 'unread' | 'reading' | 'finished' | 'favorites' | 'downloaded' | 'cloud' | 'missing';

interface Props {
  onDetail: (c: Comic) => void;
  onRead: (id: string) => void;
  notify: Notify;
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
  const { comics, progress, collections, loading } = useLibrary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>(() => (sessionStorage.getItem('lib.filter') as Filter) || 'all');
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem('lib.sort') as SortKey) || 'series');
  type LibView = 'issues' | 'series' | 'collections';
  const [libView, setLibViewState] = useState<LibView>(
    () => (localStorage.getItem('lib.view') as LibView) || (localStorage.getItem('lib.grouped') === '1' ? 'series' : 'issues'),
  );
  const setLibView = (v: LibView) => {
    setLibViewState(v);
    try {
      localStorage.setItem('lib.view', v);
    } catch {}
  };
  const grouped = libView === 'series';
  const showCollections = libView === 'collections';
  // where we are in the Series view (folder keys), kept while you pop into the reader and back
  const [folderPath, setFolderPathState] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('lib.path') || '[]');
    } catch {
      return [];
    }
  });
  const setFolderPath = (p: string[]) => {
    setFolderPathState(p);
    try {
      sessionStorage.setItem('lib.path', JSON.stringify(p));
    } catch {}
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState(false);
  const [menu2, setMenu2] = useState<{ x: number; y: number; comic: Comic } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const all = comics ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter((c) => {
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
          return !c.hasFile && !c.driveMissing;
        case 'missing':
          return !!c.driveMissing;
      }
      return true;
    });
    return sortComics(list, sort, progress);
  }, [all, query, filter, sort, progress]);

  const continueReading = useMemo(
    () =>
      sortComics(
        all.filter((c) => statusOf(progress.get(c.id)) === 'reading'),
        'recent',
        progress,
      ).slice(0, 12),
    [all, progress],
  );

  const prefs = usePrefs();
  const upNext = useMemo(() => computeUpNext(all, progress, collections, prefs.upNextHidden), [all, progress, collections, prefs.upNextHidden]);
  const [upNextMenu, setUpNextMenu] = useState<{ x: number; y: number; comic: Comic; after: Comic } | null>(null);
  const hideUpNext = (after: Comic, comic: Comic) => {
    const key = upNextKey(after.id, comic.id);
    const before = getPrefs().upNextHidden;
    setPrefs({ upNextHidden: [...before.filter((k) => k !== key), key].slice(-300) });
    notify(`Removed "${comic.title}" from Up next`, { label: 'Undo', run: () => setPrefs({ upNextHidden: getPrefs().upNextHidden.filter((k) => k !== key) }) });
  };

  const tree = useMemo(() => buildTree(visible), [visible]);
  // unfiltered, for renames/moves (so filtered-out comics move with their group)
  const fullTree = useMemo(() => buildTree(all), [all]);
  const groupByKey = (key: string) => allGroups(fullTree).find((g) => g.key === key);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ group?: string; ids?: string[] } | null>(null);

  const renameGroup = async (key: string, name: string) => {
    const g = groupByKey(key);
    if (!g) return;
    const paths = shownPaths(fullTree);
    const depth = g.path.length - 1;
    await setShelves(g.all.map((c) => ({ id: c.id, shelf: paths.get(c.id)!.map((s, i) => (i === depth ? name : s)) })));
    // stay inside the renamed group if we were in it
    if (folderPath.includes(key)) {
      const parentKey = key.slice(0, key.lastIndexOf('/'));
      setFolderPath([...folderPath.slice(0, folderPath.indexOf(key)), `${parentKey}/${name}`]);
    }
    notify(`Renamed to "${name}"`);
  };
  const moveGroup = async (key: string, target: string[]) => {
    const g = groupByKey(key);
    if (!g) return;
    const paths = shownPaths(fullTree);
    await setShelves(g.all.map((c) => ({ id: c.id, shelf: [...target, ...paths.get(c.id)!.slice(g.path.length - 1)] })));
    setFolderPath([]);
    notify(target.length ? `Moved "${g.name}" into "${target[target.length - 1]}"` : `Moved "${g.name}" to the top`);
  };
  const resetGroup = async (key: string) => {
    const g = groupByKey(key);
    if (!g) return;
    await setShelves(g.all.map((c) => ({ id: c.id, shelf: undefined })));
    setFolderPath([]);
    notify(`"${g.name}" is back to your Drive folder layout`);
  };
  const trail = grouped ? findPath(tree, folderPath) : [tree];
  const here = trail[trail.length - 1];
  const atTop = trail.length === 1;
  const shown = grouped ? sortComics(here.comics, sort === 'series' ? 'series' : sort, progress) : visible;

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
  const open = (c: Comic) => (isReadable(c) ? onRead(c.id) : onDetail(c));

  if (loading) return <div className="center-fill"><div className="spinner" /></div>;

  return (
    <div className="view library">
      <header className="view-head">
        {!atTop ? (
          <button className="icon-btn" onClick={() => setFolderPath(trail.slice(1, -1).map((n) => n.key))} aria-label="Back"><ChevronLeft /></button>
        ) : null}
        <h1>{atTop ? 'Library' : here.name}</h1>
        {!atTop && grouped && (
          <button className="icon-btn" aria-label="Rename group" title="Rename group" onClick={() => setRenaming(here.key)}>
            <Pencil size={18} />
          </button>
        )}
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
          {atTop && !query && filter === 'all' && continueReading.length > 0 && (
            <section className="shelf">
              <h2>Continue reading</h2>
              <div className="shelf-row">
                {continueReading.map((c) => (
                  <ComicCard
                    key={c.id}
                    comic={c}
                    progress={progress.get(c.id)}
                    onOpen={() => open(c)}
                    onSelect={() => onDetail(c)}
                    onMenu={(x, y) => setMenu2({ x, y, comic: c })}
                  />
                ))}
              </div>
            </section>
          )}

          {atTop && !query && filter === 'all' && upNext.length > 0 && (
            <section className="shelf">
              <h2>Up next</h2>
              <div className="shelf-row">
                {upNext.map(({ comic: c, after, via }) => (
                  <ComicCard
                    key={c.id}
                    comic={c}
                    progress={progress.get(c.id)}
                    subtitle={`After ${after.title}${via !== after.series && via !== c.series ? ` · ${via}` : ''}`}
                    onOpen={() => open(c)}
                    onSelect={() => onDetail(c)}
                    onMenu={(x, y) => setUpNextMenu({ x, y, comic: c, after })}
                  />
                ))}
              </div>
            </section>
          )}

          <div className="toolbar">
            <div className="chips">
              {!showCollections && [...FILTERS, ...(all.some((c) => c.driveMissing) ? [['missing', 'Missing from Drive'] as [Filter, string]] : [])].map(([f, label]) => (
                <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => { setFilter(f); sessionStorage.setItem('lib.filter', f); }}>
                  {label}
                </button>
              ))}
            </div>
            <div className="row gap">
              {!showCollections && (
                <button className={`btn small${selecting ? ' on' : ''}`} onClick={() => (selecting ? endSelect() : setSelectMode(true))}>
                  {selecting ? 'Done' : 'Select'}
                </button>
              )}
              {atTop && (
                <div className="segmented compact">
                  <button className={libView === 'issues' ? 'on' : ''} onClick={() => setLibView('issues')}>Issues</button>
                  <button className={libView === 'series' ? 'on' : ''} onClick={() => setLibView('series')}>Series</button>
                  <button className={libView === 'collections' ? 'on' : ''} onClick={() => { endSelect(); setLibView('collections'); }}>Collections</button>
                </div>
              )}
              {!showCollections && <select className="select" value={sort} onChange={(e) => { setSort(e.target.value as SortKey); localStorage.setItem('lib.sort', e.target.value); }} aria-label="Sort">
                <option value="series">Series & issue</option>
                <option value="recent">Recently read</option>
                <option value="added">Recently added</option>
                <option value="title">Title</option>
                <option value="year">Year</option>
              </select>}
            </div>
          </div>

          {showCollections && <CollectionsGrid query={query} fromLibrary newCard />}

          {!showCollections && !atTop && trail.length > 2 && (
            <nav className="crumbs lib-crumbs" aria-label="Folders">
              <button onClick={() => setFolderPath([])}>Library</button>
              {trail.slice(1, -1).map((n, i) => (
                <span key={n.key} className="row">
                  <ChevronRight size={14} />
                  <button onClick={() => setFolderPath(trail.slice(1, i + 2).map((x) => x.key))}>{n.name}</button>
                </span>
              ))}
            </nav>
          )}
          {!showCollections && grouped && here.folders.length > 0 && (
            <div className="grid">
              {here.folders.map((f) => {
                const read = f.all.filter((c) => statusOf(progress.get(c.id)) === 'finished').length;
                return (
                  <GroupCard
                    key={f.key}
                    group={f}
                    read={read}
                    onOpen={() => setFolderPath([...trail.slice(1).map((n) => n.key), f.key])}
                    onMenu={(x, y) => setGroupMenu({ x, y, key: f.key })}
                  />
                );
              })}
            </div>
          )}
          {grouped && here.folders.length > 0 && shown.length > 0 && <div className="grid-gap" />}
          {!showCollections && (!grouped || !atTop || here.folders.length === 0) && (
            <div className="grid">
              {shown.map((c) => (
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
          {!showCollections && !visible.length && <p className="muted center pad">Nothing matches.</p>}
        </>
      )}

      {selecting && (
        <div className="selection-bar">
          <span><strong>{selected.size}</strong> selected</span>
          <button className="btn small ghost" onClick={() => setSelected(new Set((grouped ? here.all : visible).map((c) => c.id)))}>All</button>
          <button className="btn small" onClick={() => setAdding(true)}><FolderPlus size={16} /> <span className="hide-mobile">Collection</span></button>
          <button className="btn small" title="Download for offline reading" onClick={() => { void downloadMany([...selected]); notify('Downloading for offline reading…'); endSelect(); }}>
            <CloudDownload size={16} /> <span className="hide-mobile">Download</span>
          </button>
          <button className="btn small" title="Move to a group in the Series view" onClick={() => setMoving({ ids: [...selected] })}>
            <FolderInput size={16} /> <span className="hide-mobile">Move</span>
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
      {upNextMenu && (
        <ContextMenu
          x={upNextMenu.x}
          y={upNextMenu.y}
          onClose={() => setUpNextMenu(null)}
          items={[
            { label: 'Read', icon: <BookOpen size={16} />, onClick: () => open(upNextMenu.comic) },
            { label: 'Details', icon: <Info size={16} />, onClick: () => onDetail(upNextMenu.comic) },
            { label: 'Remove from Up next', icon: <X size={16} />, danger: true, onClick: () => hideUpNext(upNextMenu.after, upNextMenu.comic) },
          ]}
        />
      )}
      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            { label: 'Rename', icon: <Pencil size={16} />, onClick: () => setRenaming(groupMenu.key) },
            { label: 'Move into…', icon: <FolderInput size={16} />, onClick: () => setMoving({ group: groupMenu.key }) },
            ...(groupByKey(groupMenu.key)?.custom
              ? [{ label: "Use Drive's layout", icon: <RotateCcw size={16} />, onClick: () => void resetGroup(groupMenu.key) }]
              : []),
          ]}
        />
      )}
      {renaming && (
        <TextPrompt
          title="Rename group"
          initial={groupByKey(renaming)?.name ?? ''}
          hint="Only changes how it shows here — your Drive folders stay as they are. Use the same name as another group to merge them."
          confirm="Rename"
          onSubmit={(name) => void renameGroup(renaming, name)}
          onClose={() => setRenaming(null)}
        />
      )}
      {moving && (
        <MoveDialog
          title={moving.group ? `Move "${groupByKey(moving.group)?.name}" into…` : `Move ${moving.ids!.length} comic${moving.ids!.length === 1 ? '' : 's'} to…`}
          tree={fullTree}
          excludeKey={moving.group}
          allowTop={!!moving.group}
          onPick={(path) => {
            if (moving.group) void moveGroup(moving.group, path);
            else
              void setShelves(moving.ids!.map((id) => ({ id, shelf: path }))).then(() => {
                notify(`Moved to "${path[path.length - 1]}"`);
                endSelect();
              });
          }}
          onClose={() => setMoving(null)}
        />
      )}
      {menu2 && (
        <ContextMenu
          x={menu2.x}
          y={menu2.y}
          onClose={() => setMenu2(null)}
          items={[
            { label: 'Continue reading', icon: <BookOpen size={16} />, onClick: () => open(menu2.comic) },
            { label: 'Details', icon: <Info size={16} />, onClick: () => onDetail(menu2.comic) },
            {
              label: 'Remove from Continue reading',
              icon: <X size={16} />,
              danger: true,
              onClick: async () => {
                const undo = await removeFromContinueReading(menu2.comic.id);
                notify(`Removed "${menu2.comic.title}" from Continue reading`, { label: 'Undo', run: () => void undo() });
              },
            },
          ]}
        />
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

/** A stacked-covers card for a group in the Series view; right-click / long-press for its menu. */
function GroupCard({ group: f, read, onOpen, onMenu }: { group: FolderNode; read: number; onOpen: () => void; onMenu: (x: number, y: number) => void }) {
  const timer = useRef<number>(undefined);
  const longPressed = useRef(false);
  return (
    <button
      className="card series-card"
      onClick={() => {
        if (longPressed.current) longPressed.current = false;
        else onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!longPressed.current) onMenu(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.pointerType !== 'touch') return;
        const { clientX, clientY } = e;
        timer.current = window.setTimeout(() => {
          longPressed.current = true;
          onMenu(clientX, clientY);
        }, 450);
      }}
      onPointerUp={() => clearTimeout(timer.current)}
      onPointerLeave={() => clearTimeout(timer.current)}
      onPointerCancel={() => clearTimeout(timer.current)}
    >
      <div className="card-cover stack">
        {f.all.slice(0, 3).reverse().map((c, i, arr) => (
          <Cover key={c.id} comic={c} className={`stack-${arr.length - 1 - i}`} />
        ))}
      </div>
      <div className="card-meta">
        <strong>{f.name}</strong>
        <span>
          {f.folders.length > 0 && `${f.folders.length} volume${f.folders.length === 1 ? '' : 's'} · `}
          {f.all.length} issue{f.all.length === 1 ? '' : 's'} · {read} read
        </span>
      </div>
    </button>
  );
}
