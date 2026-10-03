import { ArrowDown, ArrowUp, BookOpen, FolderOpen, Pencil, ChevronLeft, Cloud, CloudDownload, CloudOff, HardDriveDownload, FolderPlus, Sparkles, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Collection, Comic, SmartRule } from '../db';
import { isConnected } from '../lib/drive';
import { go } from '../lib/hooks';
import { collectionMembers, isReadable, createCollection, deleteCollection, removeFromCollection, statusOf, updateCollection } from '../lib/library';
import { downloadMany, processDriveQueue, removeDownloads } from '../lib/sync';
import { useLibrary } from '../lib/useLibrary';
import { ComicCard, Cover } from '../components/ComicCard';
import { Toggle } from '../components/reader/ReaderSettings';
import { TextPrompt } from '../components/TextPrompt';
import { ContextMenu } from '../components/ContextMenu';
import { Pressable } from '../components/Pressable';

export function Collections() {
  const { collections } = useLibrary();
  const [creating, setCreating] = useState<'manual' | 'smart' | null>(null);
  return (
    <div className="view">
      <header className="view-head">
        <h1>Collections</h1>
        <div className="row gap">
          <button className="btn" onClick={() => setCreating('smart')}><Sparkles size={18} /><span className="hide-mobile">Smart collection</span></button>
          <button className="btn primary" onClick={() => setCreating('manual')}><FolderPlus size={18} /><span className="hide-mobile">New collection</span></button>
        </div>
      </header>
      {!collections.length ? (
        <div className="empty">
          <FolderPlus size={44} strokeWidth={1.3} />
          <h2>Group comics your way</h2>
          <p className="muted">
            Collections are ordered reading lists — events, runs, crossovers, "to read next". Smart collections fill themselves from rules. Turn on
            Drive sync for a collection and its comics follow you to every device.
          </p>
        </div>
      ) : (
        <CollectionsGrid />
      )}
      {creating && <NewCollectionPrompt smart={creating === 'smart'} onClose={() => setCreating(null)} />}
    </div>
  );
}

export function NewCollectionPrompt({ smart, fromLibrary, onClose }: { smart: boolean; fromLibrary?: boolean; onClose: () => void }) {
  return (
    <TextPrompt
      title={smart ? 'New smart collection' : 'New collection'}
      confirm="Create"
      onSubmit={async (name) => {
        const id = await createCollection(name, smart ? { smart: { status: 'any' } } : {});
        go(`collection/${id}${fromLibrary ? '/lib' : ''}`);
      }}
      onClose={onClose}
    />
  );
}

/**
 * Collection cards (Collections tab, and the Library's "Collections" view).
 * Tap opens; right-click / long-press for Rename / Delete.
 */
export function CollectionsGrid({ query = '', fromLibrary = false, newCard = false }: { query?: string; fromLibrary?: boolean; newCard?: boolean }) {
  const { comics, progress, collections } = useLibrary();
  const all = comics ?? [];
  const q = query.trim().toLowerCase();
  const sorted = [...collections].filter((c) => !q || c.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  const [menu, setMenu] = useState<{ x: number; y: number; col: Collection } | null>(null);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [creating, setCreating] = useState(false);
  const open = (id: string) => go(`collection/${id}${fromLibrary ? '/lib' : ''}`);
  return (
    <>
      <div className="grid">
        {newCard && (
          <button className="card collection-card new-collection-card" onClick={() => setCreating(true)}>
            <div className="card-cover new-stack">
              <FolderPlus size={34} strokeWidth={1.5} />
            </div>
            <div className="card-meta">
              <strong>New collection</strong>
              <span>A reading list in your order</span>
            </div>
          </button>
        )}
        {sorted.map((col) => {
          const members = collectionMembers(col, all, progress);
          const read = members.filter((c) => statusOf(progress.get(c.id)) === 'finished').length;
          return (
            <Pressable key={col.id} className="card collection-card" onOpen={() => open(col.id)} onMenu={(x, y) => setMenu({ x, y, col })}>
              {/* stacked covers, same as Series groups: the first three comics in the collection */}
              <div className="card-cover stack">
                {members.length ? (
                  members.slice(0, 3).reverse().map((c, i, arr) => <Cover key={c.id} comic={c} className={`stack-${arr.length - 1 - i}`} />)
                ) : (
                  <div className="cover cover-blank">{col.name.slice(0, 1)}</div>
                )}
              </div>
              <div className="card-meta">
                <strong>
                  {col.smart && <Sparkles size={14} className="accent" />} {col.name} {col.driveSync ? <Cloud size={14} className="muted" /> : null}
                </strong>
                <span>{members.length} comics · {read} read</span>
              </div>
            </Pressable>
          );
        })}
      </div>
      {q && !sorted.length && <p className="muted center pad">No collections match.</p>}
      {creating && <NewCollectionPrompt smart={false} fromLibrary={fromLibrary} onClose={() => setCreating(false)} />}
      {renaming && (
        <TextPrompt title="Rename collection" initial={renaming.name} confirm="Rename" onSubmit={(name) => void updateCollection(renaming.id, { name })} onClose={() => setRenaming(null)} />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Open', icon: <FolderOpen size={16} />, onClick: () => open(menu.col.id) },
            { label: 'Rename', icon: <Pencil size={16} />, onClick: () => setRenaming(menu.col) },
            {
              label: 'Delete collection',
              icon: <Trash2 size={16} />,
              danger: true,
              onClick: () => {
                if (confirm(`Delete the collection "${menu.col.name}"? The comics stay in your library.`)) void deleteCollection(menu.col.id);
              },
            },
          ]}
        />
      )}
    </>
  );
}

export function CollectionDetail({ id, onRead, onDetail, backTo = 'collections' }: { id: string; onRead: (id: string) => void; onDetail: (c: Comic) => void; backTo?: string }) {
  const { comics, progress, collections } = useLibrary();
  const col = collections.find((c) => c.id === id);
  const all = comics ?? [];
  const members = useMemo(() => (col ? collectionMembers(col, all, progress) : []), [col, all, progress]);
  const [editRules, setEditRules] = useState(false);
  const [renaming, setRenaming] = useState(false);

  if (!col) return <div className="view"><p className="muted pad">Collection not found.</p></div>;

  const read = members.filter((c) => statusOf(progress.get(c.id)) === 'finished').length;
  const nextUp = members.find((c) => statusOf(progress.get(c.id)) === 'reading') ?? members.find((c) => statusOf(progress.get(c.id)) === 'unread');
  const notInDrive = members.filter((c) => c.hasFile && !c.driveFileId).length;
  const move = (i: number, d: number) => {
    const ids = [...col.comicIds];
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void updateCollection(col.id, { comicIds: ids });
  };

  return (
    <div className="view">
      <header className="view-head">
        <button className="icon-btn" onClick={() => go(backTo)} aria-label="Back"><ChevronLeft /></button>
        <h1>{col.name}</h1>
        <button className="icon-btn" aria-label="Rename collection" title="Rename" onClick={() => setRenaming(true)}>
          <Pencil size={18} />
        </button>
        <span className="grow" />
        <button
          className="icon-btn danger"
          aria-label="Delete collection"
          onClick={() => confirm(`Delete the collection "${col.name}"? The comics stay in your library.`) && void deleteCollection(col.id).then(() => go(backTo))}
        >
          <Trash2 />
        </button>
      </header>

      <div className="collection-summary">
        <div className="stat-line">
          <span><strong>{members.length}</strong> comics</span>
          <span><strong>{read}</strong> read</span>
          {members.length > 0 && <div className="progress-bar inline"><i style={{ width: `${(read / members.length) * 100}%` }} /></div>}
        </div>
        <div className="row gap wrap">
          {nextUp && isReadable(nextUp) && (
            <button className="btn primary" onClick={() => onRead(nextUp.id)}><BookOpen size={18} /> {statusOf(progress.get(nextUp.id)) === 'reading' ? 'Continue' : 'Start'}: {nextUp.title}</button>
          )}
          {col.smart && <button className="btn" onClick={() => setEditRules((v) => !v)}><Sparkles size={18} /> Rules</button>}
          {members.some((c) => !c.hasFile && c.driveFileId) && (
            <button className="btn" onClick={() => void downloadMany(members.map((c) => c.id))}>
              <CloudDownload size={18} /> Download all ({members.filter((c) => !c.hasFile && c.driveFileId).length})
            </button>
          )}
          {members.some((c) => c.hasFile && c.driveFileId) && (
            <button className="btn ghost" onClick={() => void removeDownloads(members.map((c) => c.id))}>
              <HardDriveDownload size={18} /> Remove downloads
            </button>
          )}
        </div>
        <div className="drive-toggle">
          <Toggle
            label="Sync this collection's comics to Google Drive"
            value={!!col.driveSync}
            onChange={(v) => {
              void updateCollection(col.id, { driveSync: v ? 1 : 0 }).then(() => {
                if (v) void processDriveQueue();
              });
            }}
          />
          <p className="muted small">
            {!isConnected() ? (
              <><CloudOff size={14} /> Connect Google Drive in Settings to use this.</>
            ) : col.driveSync ? (
              notInDrive ? `Uploading ${notInDrive} comic(s) so your other devices can download them…` : 'All comics here are in your Drive and available on every device.'
            ) : (
              'Progress and the collection itself always sync. Turn this on to also copy the comic files to Drive.'
            )}
          </p>
        </div>
        {editRules && col.smart && <RuleEditor col={col} />}
      </div>

      {col.smart ? (
        <div className="grid">
          {members.map((c) => (
            <ComicCard key={c.id} comic={c} progress={progress.get(c.id)} onOpen={() => (isReadable(c) ? onRead(c.id) : onDetail(c))} onSelect={() => onDetail(c)} />
          ))}
        </div>
      ) : (
        <ol className="reading-list">
          {members.map((c, i) => {
            const st = statusOf(progress.get(c.id));
            return (
              <li key={c.id} className={st}>
                <span className="rl-num">{i + 1}</span>
                <button className="rl-main" onClick={() => (isReadable(c) ? onRead(c.id) : onDetail(c))}>
                  <Cover comic={c} className="rl-cover" />
                  <span className="rl-text">
                    <strong>{c.title}</strong>
                    <span className="muted small">
                      {c.series}{c.number ? ` #${c.number}` : ''} · {st === 'finished' ? 'Read' : st === 'reading' ? 'In progress' : 'Unread'}
                      {!c.hasFile ? ' · streams from Drive' : ''}
                    </span>
                  </span>
                </button>
                <div className="rl-actions">
                  <button className="icon-btn tiny" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={16} /></button>
                  <button className="icon-btn tiny" onClick={() => move(i, 1)} disabled={i === members.length - 1} aria-label="Move down"><ArrowDown size={16} /></button>
                  <button className="icon-btn tiny" onClick={() => void removeFromCollection(col.id, [c.id])} aria-label="Remove from collection"><X size={16} /></button>
                </div>
              </li>
            );
          })}
          {!members.length && <p className="muted pad">Add comics from the Library: tap Select, choose some, then "Collection".</p>}
        </ol>
      )}
      {renaming && (
        <TextPrompt title="Rename collection" initial={col.name} confirm="Rename" onSubmit={(name) => void updateCollection(col.id, { name })} onClose={() => setRenaming(false)} />
      )}
    </div>
  );
}

function RuleEditor({ col }: { col: Collection }) {
  const [r, setR] = useState<SmartRule>(col.smart ?? {});
  const save = (patch: Partial<SmartRule>) => {
    const next = { ...r, ...patch };
    setR(next);
    void updateCollection(col.id, { smart: next });
  };
  return (
    <div className="rule-editor">
      <label className="field"><span>Text contains</span><input value={r.text ?? ''} onChange={(e) => save({ text: e.target.value || undefined })} placeholder="e.g. Batman" /></label>
      <label className="field"><span>Status</span>
        <select value={r.status ?? 'any'} onChange={(e) => save({ status: e.target.value as SmartRule['status'] })}>
          <option value="any">Any</option>
          <option value="unread">Unread</option>
          <option value="reading">In progress</option>
          <option value="finished">Finished</option>
        </select>
      </label>
      <label className="field"><span>Publisher</span><input value={r.publisher ?? ''} onChange={(e) => save({ publisher: e.target.value || undefined })} /></label>
      <div className="row gap">
        <label className="field"><span>Year from</span><input inputMode="numeric" value={r.yearFrom ?? ''} onChange={(e) => save({ yearFrom: Number(e.target.value) || undefined })} /></label>
        <label className="field"><span>Year to</span><input inputMode="numeric" value={r.yearTo ?? ''} onChange={(e) => save({ yearTo: Number(e.target.value) || undefined })} /></label>
      </div>
      <Toggle label="Favorites only" value={!!r.favoritesOnly} onChange={(favoritesOnly) => save({ favoritesOnly })} />
    </div>
  );
}
