import { ChevronRight, Folder, FolderOpen, Link2, RefreshCw, Unlink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FOLDER_MIME, hasFolderAccess, listChildren, listSharedFolders, requestToken, type DriveItem } from '../lib/drive';
import { detectFormat } from '../lib/archive';
import { getLinkedFolders, linkFolder, onFoldersChanged, scanLinkedFolders, unlinkFolder, useDriveLibraryStatus, type LinkedFolder } from '../lib/driveLibrary';
import { timeAgo } from '../lib/library';
import { getRarIssues } from '../lib/remote';

/** Settings section: Drive folders that make up the cloud library. */
export function DriveFolders({ notify, onAuthError }: { notify: (m: string) => void; onAuthError: (e: unknown) => void }) {
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [access, setAccess] = useState(hasFolderAccess);
  const [picking, setPicking] = useState(false);
  const status = useDriveLibraryStatus();

  useEffect(() => {
    const load = () => void getLinkedFolders().then((s) => setFolders(s.value));
    load();
    return onFoldersChanged(load);
  }, []);

  if (!access) {
    return (
      <div className="notice">
        <FolderOpen size={20} className="accent" />
        <div className="grow">
          <strong>Read comics straight from your Drive folders</strong>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>
            Link a folder and everything in it shows up in your library on every device. It streams when you open it, and you can download any of it for offline reading.
            This needs read-only access to your Drive. Google will show an “unverified app” screen because this is your own private app — choose Advanced → Continue.
          </p>
          <button
            className="btn primary small"
            onClick={() =>
              requestToken(true).then(() => setAccess(hasFolderAccess()), onAuthError)
            }
          >
            Allow folder access
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <h3 className="subhead">Library folders</h3>
      <p className="muted small">Comics in these Drive folders (and their subfolders) appear in your library on every device and stream when opened.</p>
      <ul className="folder-list">
        {folders.map((f) => (
          <li key={f.id}>
            <Folder size={18} className="accent" />
            <span className="grow ellipsis">{f.name}</span>
            <button
              className="icon-btn tiny"
              aria-label={`Unlink ${f.name}`}
              title="Unlink folder"
              onClick={() =>
                confirm(`Unlink "${f.name}"? Its comics leave your library (downloaded ones stay). Nothing in your Drive is changed.`) && void unlinkFolder(f.id)
              }
            >
              <Unlink size={16} />
            </button>
          </li>
        ))}
        {!folders.length && <li className="muted small">No folders linked yet.</li>}
      </ul>
      <div className="row gap wrap">
        <button className="btn primary small" onClick={() => setPicking(true)}><Link2 size={16} /> Link a Drive folder</button>
        {folders.length > 0 && (
          <button className="btn small" disabled={status.scanning} onClick={() => void scanLinkedFolders(true)}>
            <RefreshCw size={16} className={status.scanning ? 'spin' : ''} /> {status.scanning ? 'Scanning…' : 'Rescan now'}
          </button>
        )}
      </div>
      <p className="muted small">
        {status.scanError
          ? `Scan problem: ${status.scanError}`
          : status.covers.total
            ? `Getting covers ${status.covers.done}/${status.covers.total}…`
            : folders.length
              ? `Checked ${timeAgo(status.lastScan ?? (Number(localStorage.getItem('driveLibrary.lastScan')) || undefined))}. New files are picked up automatically.`
              : ''}
      </p>
      <RarIssues />
      {picking && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onPick={(f) => {
            setPicking(false);
            notify(`Linked "${f.name}" — scanning…`);
            linkFolder(f).then(
              () => notify(`"${f.name}" added to your library`),
              (e) => notify((e as Error).message),
            );
          }}
        />
      )}
    </>
  );
}

function FolderPicker({ onClose, onPick }: { onClose: () => void; onPick: (f: { id: string; name: string }) => void }) {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [items, setItems] = useState<DriveItem[] | null>(null);
  const [error, setError] = useState<string>();
  const here = trail[trail.length - 1];

  useEffect(() => {
    setItems(null);
    setError(undefined);
    (here.id === 'shared' ? listSharedFolders() : listChildren(here.id)).then(setItems, (e) => setError((e as Error).message));
  }, [here.id]);

  const folders = items?.filter((i) => i.mimeType === FOLDER_MIME) ?? [];
  const comicsHere = items?.filter((i) => i.mimeType !== FOLDER_MIME && detectFormat(i.name)).length ?? 0;
  const atTop = here.id === 'root' || here.id === 'shared';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="sheet folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>Choose a folder</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="crumbs">
          {trail.length === 1 && (
            <div className="segmented compact" style={{ marginBottom: 6 }}>
              <button className={here.id === 'root' ? 'on' : ''} onClick={() => setTrail([{ id: 'root', name: 'My Drive' }])}>My Drive</button>
              <button className={here.id === 'shared' ? 'on' : ''} onClick={() => setTrail([{ id: 'shared', name: 'Shared with me' }])}>Shared with me</button>
            </div>
          )}
          {trail.length > 1 &&
            trail.map((t, i) => (
              <span key={t.id} className="row">
                {i > 0 && <ChevronRight size={14} />}
                <button onClick={() => setTrail(trail.slice(0, i + 1))}>{t.name}</button>
              </span>
            ))}
        </div>
        <div className="list">
          {error && <p className="warn small pad">{error}</p>}
          {!items && !error && <div className="center-fill pad"><div className="spinner" /></div>}
          {folders.map((f) => (
            <button key={f.id} className="list-row" onClick={() => setTrail([...trail, { id: f.id, name: f.name }])}>
              <Folder size={18} className="accent" />
              <span className="grow ellipsis">{f.name}</span>
              <ChevronRight size={16} className="muted" />
            </button>
          ))}
          {items && !folders.length && <p className="muted small pad">No subfolders here.</p>}
        </div>
        <div className="picker-foot">
          <span className="grow muted small">
            {atTop ? 'Open the folder that holds your comics.' : `${comicsHere} comic file${comicsHere === 1 ? '' : 's'} directly in “${here.name}” (subfolders are included too).`}
          </span>
          <button className="btn primary" disabled={atTop} onClick={() => onPick(here)}>Use this folder</button>
        </div>
      </div>
    </div>
  );
}

function RarIssues() {
  const issues = Object.entries(getRarIssues());
  if (!issues.length) return null;
  return (
    <details className="rar-issues">
      <summary className="muted small">{issues.length} CBR file{issues.length === 1 ? '' : 's'} can't stream page by page (they download whole instead)</summary>
      <ul>
        {issues.map(([name, why]) => (
          <li key={name} className="small">
            <strong>{name}</strong> — {why}
          </li>
        ))}
      </ul>
    </details>
  );
}
