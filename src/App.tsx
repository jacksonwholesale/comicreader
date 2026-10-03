import { BarChart3, Cloud, CloudOff, FolderHeart, Library as LibraryIcon, Loader2, Settings as SettingsIcon, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { APP } from './config';
import { db, type Comic } from './db';
import { go, useMediaQuery, useRoute } from './lib/hooks';
import { collectFromDrop } from './lib/importer';
import { clearImportResult, queueImport, useImportState } from './lib/importQueue';
import { usePrefs } from './lib/prefs';
import { dismissTransfer } from './lib/sync';
import { useSyncStatus, useTransfers } from './lib/useLibrary';
import { ComicDetail } from './components/ComicDetail';
import { Reader } from './components/reader/Reader';
import { CollectionDetail, Collections } from './views/Collections';
import { Library } from './views/Library';
import { Settings } from './views/Settings';
import { Stats } from './views/Stats';

export interface ToastAction {
  label: string;
  run: () => void;
}
export type Notify = (text: string, action?: ToastAction) => void;

export function App() {
  const route = useRoute();
  const prefs = usePrefs();
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [detail, setDetail] = useState<Comic | null>(null);
  const [toast, setToast] = useState<{ text: string; action?: ToastAction; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const theme = prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const notify = useCallback((text: string, action?: ToastAction) => {
    const id = Date.now();
    setToast({ text, action, id });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), action ? 6000 : 3500);
  }, []);

  const read = useCallback((id: string) => {
    setDetail(null);
    go(`read/${id}`);
  }, []);

  // keep the detail sheet live (progress, downloads)
  useEffect(() => {
    if (!detail) return;
    const sub = setInterval(async () => {
      const fresh = await db.comics.get(detail.id);
      if (!fresh || fresh.deleted) setDetail(null);
      else if (fresh.updatedAt !== detail.updatedAt || fresh.hasFile !== detail.hasFile) setDetail(fresh);
    }, 700);
    return () => clearInterval(sub);
  }, [detail]);

  // drag & drop anywhere
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      queueImport(await collectFromDrop(e.dataTransfer!));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const [section, arg] = route;

  if (section === 'read' && arg) {
    return <Reader key={arg} comicId={arg} onClose={() => (history.length > 1 ? history.back() : go(''))} onOpen={(id) => go(`read/${id}`)} />;
  }

  return (
    <div className="app">
      <Nav section={section === 'collection' && route[2] === 'lib' ? '' : section ?? ''} />
      <main className="main">
        {section === 'collections' ? (
          <Collections />
        ) : section === 'collection' && arg ? (
          <CollectionDetail id={arg} onRead={read} onDetail={setDetail} backTo={route[2] === 'lib' ? '' : 'collections'} />
        ) : section === 'stats' ? (
          <Stats onRead={read} />
        ) : section === 'settings' ? (
          <Settings notify={notify} />
        ) : (
          <Library onDetail={setDetail} onRead={read} notify={notify} />
        )}
      </main>

      {detail && <ComicDetail comic={detail} onClose={() => setDetail(null)} onRead={read} notify={notify} />}
      <Activity />
      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <LibraryIcon size={48} />
            <p>Drop comics or folders to add them to {APP.name}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Nav({ section }: { section: string }) {
  const sync = useSyncStatus();
  const items = [
    ['', LibraryIcon, 'Library'],
    ['collections', FolderHeart, 'Collections'],
    ['stats', BarChart3, 'Reading'],
    ['settings', SettingsIcon, 'Settings'],
  ] as const;
  const active = section === 'collection' ? 'collections' : section;
  return (
    <nav className="nav">
      <div className="brand">
        <img src="./icon.svg" alt="" width={28} height={28} />
        <span>{APP.name}</span>
      </div>
      {items.map(([path, Icon, label]) => (
        <a key={label} href={`#/${path}`} className={active === path ? 'on' : ''}>
          <Icon size={22} />
          <span>{label}</span>
        </a>
      ))}
      <a href="#/settings" className="sync-pill" title={sync.state === 'error' ? sync.message : undefined}>
        {sync.state === 'off' ? (
          <><CloudOff size={16} /> <span>Sync off</span></>
        ) : sync.state === 'syncing' ? (
          <><Loader2 size={16} className="spin" /> <span>Syncing</span></>
        ) : sync.state === 'error' ? (
          <><CloudOff size={16} className="warn" /> <span>Sync issue</span></>
        ) : (
          <><Cloud size={16} /> <span>Synced</span></>
        )}
      </a>
    </nav>
  );
}

/** Import progress + Drive uploads/downloads. */
function Activity() {
  const imp = useImportState();
  const transfers = useTransfers();
  if (!imp.running && !imp.last && !transfers.length) return null;
  return (
    <div className="activity">
      {imp.running && (
        <div className="activity-row">
          <Loader2 size={16} className="spin" />
          <div className="grow">
            <span className="ellipsis">Importing {imp.current || '…'}</span>
            <div className="progress-bar inline"><i style={{ width: `${(imp.done / Math.max(1, imp.total)) * 100}%` }} /></div>
          </div>
          <span className="muted small">{imp.done}/{imp.total}</span>
        </div>
      )}
      {!imp.running && imp.last && (
        <div className="activity-row">
          <div className="grow">
            <span>
              Added {imp.last.added}
              {imp.last.skipped ? ` · ${imp.last.skipped} already in library` : ''}
              {imp.last.failed.length ? ` · ${imp.last.failed.length} failed` : ''}
            </span>
            {imp.last.failed.slice(0, 3).map((f) => (
              <span key={f.name} className="muted small ellipsis">{f.name}: {f.error}</span>
            ))}
          </div>
          <button className="icon-btn tiny" onClick={clearImportResult} aria-label="Dismiss"><X size={16} /></button>
        </div>
      )}
      {transfers.map((t) => (
        <div key={t.id} className="activity-row">
          {t.error ? <CloudOff size={16} className="warn" /> : <Loader2 size={16} className="spin" />}
          <div className="grow">
            <span className="ellipsis">{t.kind === 'upload' ? 'Uploading' : 'Downloading'} {t.title}</span>
            {t.error ? <span className="muted small">{t.error}</span> : <div className="progress-bar inline"><i style={{ width: `${t.progress * 100}%` }} /></div>}
          </div>
          {t.error && <button className="icon-btn tiny" onClick={() => dismissTransfer(t.id)} aria-label="Dismiss"><X size={16} /></button>}
        </div>
      ))}
    </div>
  );
}
