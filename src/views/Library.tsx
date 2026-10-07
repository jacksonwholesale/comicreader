import { ArrowLeftRight, Ungroup, BookOpen, CheckCheck, FolderInput, Pencil, ChevronLeft, Info, ChevronRight, CloudDownload, HardDriveDownload, FilePlus2, FolderOpen, FolderPlus, Library as LibraryIcon, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Comic } from '../db';
import { ACCEPT, IMAGE_ACCEPT } from '../lib/archive';
import { collectFromDirectory, fromFileList } from '../lib/importer';
import { queueImport } from '../lib/importQueue';
import { addToCollection, createCollection, deleteComics, isReadable, removeFromContinueReading, setFinished, setShelves, sortComics, statusOf, type SortKey } from '../lib/library';
import { useLibrary } from '../lib/useLibrary';
import { allGroups, buildTree, findPath, shownPaths, type FolderNode } from '../lib/folders';
import { TextPrompt } from '../components/TextPrompt';
import { MoveDialog } from '../components/MoveDialog';
import { computeUpNext, upNextKey } from '../lib/upNext';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs';
import { downloadMany, removeDownloads } from '../lib/sync';
import { ComicCard } from '../components/ComicCard';
import { AddToCollection } from '../components/AddToCollection';
import { ContextMenu } from '../components/ContextMenu';
import { GroupCard } from '../components/GroupCard';
import { setDropHandler, useDragState, type DragPayload } from '../lib/dnd';
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
  const upNext = useMemo(() => computeUpNext(all, progress, collections, prefs.upNextHidden, prefs.groupOrder), [all, progress, collections, prefs.upNextHidden, prefs.groupOrder]);
  const [upNextMenu, setUpNextMenu] = useState<{ x: number; y: number; comic: Comic; after: Comic } | null>(null);
  const hideUpNext = (after: Comic, comic: Comic) => {
    const key = upNextKey(after.id, comic.id);
    const before = getPrefs().upNextHidden;
    setPrefs({ upNextHidden: [...before.filter((k) => k !== key), key].slice(-300) });
    notify(`Removed "${comic.title}" from Up next`, { label: 'Undo', run: () => setPrefs({ upNextHidden: getPrefs().upNextHidden.filter((k) => k !== key) }) });
  };

  const tree = useMemo(() => buildTree(visible, prefs.groupOrder), [visible, prefs.groupOrder]);
  // unfiltered, for renames/moves (so filtered-out comics move with their group)
  const fullTree = useMemo(() => buildTree(all, prefs.groupOrder), [all, prefs.groupOrder]);
  // Reorder mode: arrows on each cover; the order is also the reading order (Up next follows it)
  const [arranging, setArranging] = useState(false);
  const moveItem = (index: number, delta: number) => {
    // order the full group (so filtered-out items keep their place), using what's shown as the guide
    const full = groupByKey(here.key) ?? (here.key === fullTree.key ? fullTree : null);
    if (!full) return;
    const ids = full.items.map((it) => it.id);
    const shownIds = here.items.map((it) => it.id);
    const a = ids.indexOf(shownIds[index]);
    const b = ids.indexOf(shownIds[index + delta]);
    if (a < 0 || b < 0) return;
    [ids[a], ids[b]] = [ids[b], ids[a]];
    setPrefs({ groupOrder: { ...getPrefs().groupOrder, [here.key]: ids } });
  };
  const resetOrder = () => {
    const { [here.key]: _drop, ...rest } = getPrefs().groupOrder;
    setPrefs({ groupOrder: rest });
    notify('Back to the automatic order');
  };
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
  // Drag and drop: onto a collection (adds), a group (moves into it) or "New collection".
  const [dropNew, setDropNew] = useState<DragPayload | null>(null);
  useEffect(() => {
    setDropHandler(async (p, target) => {
      const what = p.kind === 'group' ? `"${p.label}" (${p.ids.length})` : `"${p.label}"`;
      if (target.startsWith('col:')) {
        const col = collections.find((c) => c.id === target.slice(4));
        if (!col) return;
        await addToCollection(col.id, p.ids);
        notify(`Added ${what} to ${col.name}`);
      } else if (target === 'newcol') {
        setDropNew(p);
      } else if (target === 'up') {
        // dragged onto "move out of this group"
        const parent = here.path.slice(0, -1);
        if (p.kind === 'group') await moveGroup(p.key, parent);
        else {
          await setShelves(p.ids.map((id) => ({ id, shelf: parent })));
          notify(`Moved ${what} out of "${here.name}"`);
        }
      } else if (target.startsWith('group:')) {
        const key = target.slice(6);
        if (p.kind === 'group' && (key === p.key || key.startsWith(`${p.key}/`))) return; // onto itself
        const g = groupByKey(key);
        if (!g) return;
        if (p.kind === 'group') await moveGroup(p.key, g.path);
        else {
          await setShelves(p.ids.map((id) => ({ id, shelf: g.path })));
          notify(`Moved ${what} into "${g.name}"`);
        }
      }
    });
    return () => setDropHandler(null);
  });

  // Ungroup: everything inside moves up one level and the group disappears.
  const ungroup = async (key: string) => {
    const g = groupByKey(key);
    if (!g) return;
    const paths = shownPaths(fullTree);
    const depth = g.path.length - 1;
    await setShelves(g.all.map((c) => {
      const p = paths.get(c.id)!;
      return { id: c.id, shelf: [...p.slice(0, depth), ...p.slice(depth + 1)] };
    }));
    // if you were inside the group you just dissolved, step out to its parent; otherwise stay put
    if (folderPath.includes(key)) setFolderPath(folderPath.slice(0, folderPath.indexOf(key)));
    notify(`Ungrouped "${g.name}"`);
  };
  // Move comics one level up, out of the group they're shown in.
  const moveOutOfGroup = async (ids: string[]) => {
    const paths = shownPaths(fullTree);
    await setShelves(ids.map((id) => ({ id, shelf: (paths.get(id) ?? []).slice(0, -1) })));
  };
  const [comicMenu, setComicMenu] = useState<{ x: number; y: number; comic: Comic } | null>(null);
  const [addingIds, setAddingIds] = useState<string[] | null>(null);

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
  // selecting a stack selects every issue in it
  const groupSelection = (g: FolderNode): 'all' | 'some' | 'none' => {
    const n = g.all.filter((c) => selected.has(c.id)).length;
    return n === 0 ? 'none' : n === g.all.length ? 'all' : 'some';
  };
  const toggleGroup = (g: FolderNode) =>
    setSelected((s) => {
      const next = new Set(s);
      const all = groupSelection(g) === 'all';
      for (const c of g.all) all ? next.delete(c.id) : next.add(c.id);
      return next;
    });
  // Collections view: what isn't in any of your collections yet, as series stacks
  const looseTree = useMemo(() => {
    const inCollections = new Set(collections.filter((c) => !c.smart && !c.deleted).flatMap((c) => c.comicIds));
    return buildTree(visible.filter((c) => !inCollections.has(c.id)));
  }, [visible, collections]);
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
              <button className={`btn small${selecting ? ' on' : ''}`} onClick={() => (selecting ? endSelect() : setSelectMode(true))}>
                {selecting ? 'Done' : 'Select'}
              </button>
              {atTop && (
                <div className="segmented compact">
                  <button className={libView === 'issues' ? 'on' : ''} onClick={() => setLibView('issues')}>Issues</button>
                  <button className={libView === 'series' ? 'on' : ''} onClick={() => setLibView('series')}>Series</button>
                  <button className={libView === 'collections' ? 'on' : ''} onClick={() => setLibView('collections')}>Collections</button>
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

          {showCollections && (
            <>
              <CollectionsGrid query={query} fromLibrary newCard />
              {(looseTree.folders.length > 0 || looseTree.comics.length > 0) && (
                <section className="loose">
                  <div className="shelf-head">
                    <h2>Not in a collection</h2>
                    <span className="muted small">Select stacks and tap “Move to collection” to file them</span>
                  </div>
                  <div className="grid">
                    {looseTree.folders.map((g) => (
                      <GroupCard
                        key={g.key}
                        group={g}
                        progress={progress}
                        selecting={selecting}
                        selected={groupSelection(g)}
                        onToggle={() => toggleGroup(g)}
                        dropTarget
                        onOpen={() => {
                          setLibView('series');
                          setFolderPath([g.key]);
                        }}
                        onMenu={(x, y) => setGroupMenu({ x, y, key: g.key })}
                      />
                    ))}
                    {looseTree.comics.map((c) => (
                      <ComicCard
                        key={c.id}
                        comic={c}
                        progress={progress.get(c.id)}
                        selecting={selecting}
                        selected={selected.has(c.id)}
                        onOpen={() => open(c)}
                        onSelect={() => (selecting ? toggle(c.id) : onDetail(c))}
                        onMenu={(x, y) => setComicMenu({ x, y, comic: c })}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

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
          {!showCollections && grouped && (here.items.length > 1 || arranging) && (
            <div className="arrange-bar">
              {arranging ? (
                <>
                  <span className="muted small grow">Use the arrows to set the order. It's also the reading order Up next follows.</span>
                  {prefs.groupOrder[here.key] && <button className="btn small ghost" onClick={resetOrder}>Reset order</button>}
                  <button className="btn small primary" onClick={() => setArranging(false)}>Done</button>
                </>
              ) : (
                <button className="btn small ghost" onClick={() => { endSelect(); setArranging(true); }}>
                  <ArrowLeftRight size={16} /> Reorder
                </button>
              )}
            </div>
          )}
          {!showCollections && grouped && (
            <div className="grid">
              {here.items.map((it, index) => {
                const f = it.kind === 'group' ? it.node : null;
                const c = it.kind === 'comic' ? it.comic : null;
                const card = f ? (
                  <GroupCard
                    key={f.key}
                    group={f}
                    progress={progress}
                    selecting={selecting}
                    selected={groupSelection(f)}
                    onToggle={() => toggleGroup(f)}
                    dropTarget
                    onOpen={() => setFolderPath([...trail.slice(1).map((n) => n.key), f.key])}
                    onMenu={(x, y) => setGroupMenu({ x, y, key: f.key })}
                  />
                ) : (
                  <ComicCard
                    key={c!.id}
                    comic={c!}
                    progress={progress.get(c!.id)}
                    selecting={selecting}
                    selected={selected.has(c!.id)}
                    onOpen={() => open(c!)}
                    onSelect={() => (selecting ? toggle(c!.id) : onDetail(c!))}
                    onMenu={(x, y) => setComicMenu({ x, y, comic: c! })}
                  />
                );
                if (!arranging) return <div key={it.id} className="grid-cell">{card}</div>;
                return (
                  <div key={it.id} className="grid-cell arranging">
                    <div className="arrange-lock">{card}</div>
                    <div className="arrange-controls">
                      <span className="arrange-pos">{index + 1}</span>
                      <button className="icon-btn tiny" aria-label="Earlier" disabled={index === 0} onClick={() => moveItem(index, -1)}><ChevronLeft size={18} /></button>
                      <button className="icon-btn tiny" aria-label="Later" disabled={index === here.items.length - 1} onClick={() => moveItem(index, 1)}><ChevronRight size={18} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!showCollections && !grouped && shown.length > 0 && (
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
                  onMenu={(x, y) => setComicMenu({ x, y, comic: c })}
                />
              ))}
            </div>
          )}
          {!showCollections && !visible.length && <p className="muted center pad">Nothing matches.</p>}
          {grouped && !atTop && <DragOutBar groupName={here.name} />}
        </>
      )}

      {selecting && (
        <div className="selection-bar">
          <span><strong>{selected.size}</strong> selected</span>
          <button className="btn small ghost" onClick={() => setSelected(new Set((grouped ? here.all : visible).map((c) => c.id)))}>All</button>
          <button className="btn small primary" disabled={!selected.size} title="Move to collection" onClick={() => setAdding(true)}>
            <FolderPlus size={16} /> <span>To collection</span>
          </button>
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
      {dropNew && (
        <TextPrompt
          title="New collection"
          hint={`With ${dropNew.kind === 'group' ? `"${dropNew.label}" (${dropNew.ids.length} issues)` : `"${dropNew.label}"`} in it.`}
          confirm="Create"
          onSubmit={async (name) => {
            const id = await createCollection(name);
            await addToCollection(id, dropNew.ids);
            notify(`Created "${name}"`);
          }}
          onClose={() => setDropNew(null)}
        />
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
      {comicMenu && (() => {
        const c = comicMenu.comic;
        const inGroup = (shownPaths(fullTree).get(c.id) ?? []).at(-1);
        return (
          <ContextMenu
            x={comicMenu.x}
            y={comicMenu.y}
            onClose={() => setComicMenu(null)}
            items={[
              ...(isReadable(c) ? [{ label: 'Read', icon: <BookOpen size={16} />, onClick: () => open(c) }] : []),
              { label: 'Details', icon: <Info size={16} />, onClick: () => onDetail(c) },
              ...(inGroup
                ? [{ label: `Remove from "${inGroup}"`, icon: <X size={16} />, onClick: () => void moveOutOfGroup([c.id]).then(() => notify(`Moved "${c.title}" out of "${inGroup}"`)) }]
                : []),
              { label: 'Move to…', icon: <FolderInput size={16} />, onClick: () => setMoving({ ids: [c.id] }) },
              { label: 'Add to collection', icon: <FolderPlus size={16} />, onClick: () => setAddingIds([c.id]) },
            ]}
          />
        );
      })()}
      {addingIds && <AddToCollection comicIds={addingIds} onClose={() => setAddingIds(null)} notify={notify} />}
      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            { label: 'Rename', icon: <Pencil size={16} />, onClick: () => setRenaming(groupMenu.key) },
            { label: 'Move into…', icon: <FolderInput size={16} />, onClick: () => setMoving({ group: groupMenu.key }) },
            { label: 'Ungroup', icon: <Ungroup size={16} />, onClick: () => void ungroup(groupMenu.key) },
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
          allowTop
          onPick={(path) => {
            if (moving.group) void moveGroup(moving.group, path);
            else
              void setShelves(moving.ids!.map((id) => ({ id, shelf: path }))).then(() => {
                notify(path.length ? `Moved to "${path[path.length - 1]}"` : 'Moved to the top of the library');
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
      {adding && <AddToCollection title="Move to collection" comicIds={[...selected]} onClose={() => { setAdding(false); endSelect(); }} notify={notify} />}
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

/** While dragging inside a group: drop here to move it out (one level up). */
function DragOutBar({ groupName }: { groupName: string }) {
  const drag = useDragState();
  if (!drag) return null;
  return (
    <div className="drag-out-bar" data-drop="up">
      ⬆ Drop here to move out of “{groupName}”
    </div>
  );
}
