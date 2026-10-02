import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, CloudDownload, CloudUpload, FolderPlus, Heart, Pencil, Trash2, X, HardDriveDownload, RotateCcw, CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { db, type Comic } from '../db';
import { isConnected } from '../lib/drive';
import { deleteComics, formatBytes, formatDuration, percentOf, removeDownload, setFinished, statusOf, timeAgo, updateComic } from '../lib/library';
import { downloadFromDrive, uploadToDrive } from '../lib/sync';
import { Cover } from './ComicCard';
import { AddToCollection } from './AddToCollection';
import { useTransfers } from '../lib/useLibrary';

interface Props {
  comic: Comic;
  onClose: () => void;
  onRead: (id: string) => void;
  notify: (msg: string) => void;
}

export function ComicDetail({ comic, onClose, onRead, notify }: Props) {
  const progress = useLiveQuery(() => db.progress.get(comic.id), [comic.id]);
  const sessions = useLiveQuery(() => db.sessions.where('comicId').equals(comic.id).toArray(), [comic.id], []);
  const transfers = useTransfers();
  const transfer = transfers.find((t) => t.id === comic.id);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const status = statusOf(progress);
  const readMs = sessions.reduce((s, x) => s + (x.endedAt - x.startedAt), 0);
  const connected = isConnected();

  const act = (fn: () => Promise<unknown>, done?: string) => fn().then(() => done && notify(done), (e) => notify((e as Error).message));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="sheet detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={comic.title}>
        <button className="icon-btn close-x" onClick={onClose} aria-label="Close"><X /></button>
        <div className="detail-top">
          <Cover comic={comic} className="detail-cover" />
          <div className="detail-info">
            <p className="eyebrow">{comic.series}{comic.volume ? ` · Vol ${comic.volume}` : ''}{comic.number ? ` · #${comic.number}` : ''}</p>
            <h2>{comic.title}</h2>
            <p className="muted small">
              {[comic.writer, comic.artist, comic.publisher, comic.year].filter(Boolean).join(' · ') || comic.fileName}
            </p>
            <div className="detail-progress">
              {status === 'reading' && (
                <>
                  <div className="progress-bar inline"><i style={{ width: `${percentOf(progress, comic)}%` }} /></div>
                  <span className="small">Page {(progress?.page ?? 0) + 1} of {comic.pageCount}{progress?.device ? ` · on ${progress.device}` : ''}</span>
                </>
              )}
              {status === 'finished' && <span className="pill ok">Finished</span>}
              {status === 'unread' && <span className="pill">Unread</span>}
            </div>
            <div className="row gap wrap">
              {comic.hasFile ? (
                <button className="btn primary" onClick={() => onRead(comic.id)}>
                  <BookOpen size={18} /> {status === 'reading' ? 'Continue' : status === 'finished' ? 'Read again' : 'Read'}
                </button>
              ) : comic.driveFileId ? (
                <button className="btn primary" disabled={!!transfer && !transfer.error} onClick={() => act(() => downloadFromDrive(comic.id), 'Downloaded')}>
                  <CloudDownload size={18} /> {transfer && !transfer.error ? `Downloading ${Math.round(transfer.progress * 100)}%` : 'Download from Drive'}
                </button>
              ) : (
                <p className="muted small">This comic's file is on another device. Upload it to Drive from there (or add it to a Drive-synced collection) to read it here.</p>
              )}
              <button className={`icon-btn${comic.favorite ? ' accent' : ''}`} aria-label="Favorite" onClick={() => void updateComic(comic.id, { favorite: comic.favorite ? 0 : 1 })}>
                <Heart fill={comic.favorite ? 'currentColor' : 'none'} />
              </button>
            </div>
          </div>
        </div>

        {comic.summary && <p className="summary">{comic.summary}</p>}

        <div className="action-list">
          {status !== 'finished' ? (
            <button onClick={() => act(() => setFinished([comic.id], true), 'Marked as read')}><CheckCheck size={18} /> Mark as read</button>
          ) : (
            <button onClick={() => act(() => setFinished([comic.id], false), 'Marked as unread')}><RotateCcw size={18} /> Mark as unread</button>
          )}
          <button onClick={() => setAdding(true)}><FolderPlus size={18} /> Add to collection</button>
          <button onClick={() => setEditing((e) => !e)}><Pencil size={18} /> Edit details</button>
          {comic.hasFile && !comic.driveFileId && (
            <button disabled={!connected || (!!transfer && !transfer.error)} onClick={() => act(() => uploadToDrive(comic.id), 'Uploaded to Google Drive')}>
              <CloudUpload size={18} />
              {transfer && !transfer.error ? `Uploading ${Math.round(transfer.progress * 100)}%` : connected ? 'Upload to Google Drive' : 'Upload to Drive (connect in Settings)'}
            </button>
          )}
          {comic.hasFile && comic.driveFileId ? (
            <button onClick={() => act(() => removeDownload(comic.id), 'Removed from this device — still in Drive')}><HardDriveDownload size={18} /> Remove download (keep in Drive)</button>
          ) : null}
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Delete "${comic.title}" from your library on all devices${comic.driveFileId ? ' and from Google Drive' : ''}?`)) {
                void deleteComics([comic.id]).then(onClose);
              }
            }}
          >
            <Trash2 size={18} /> Delete
          </button>
        </div>

        {editing && <EditForm comic={comic} onDone={() => setEditing(false)} />}

        <dl className="facts">
          <div><dt>Format</dt><dd>{comic.format.toUpperCase()} · {comic.pageCount} pages · {formatBytes(comic.size)}</dd></div>
          <div><dt>Added</dt><dd>{new Date(comic.addedAt).toLocaleDateString()}</dd></div>
          <div><dt>Last read</dt><dd>{timeAgo(progress?.lastReadAt)}</dd></div>
          <div><dt>Time spent</dt><dd>{formatDuration(readMs)} over {sessions.length} session{sessions.length === 1 ? '' : 's'}</dd></div>
          <div><dt>Storage</dt><dd>{comic.hasFile ? 'On this device' : 'Not on this device'}{comic.driveFileId ? ' · In Google Drive' : ''}</dd></div>
          <div><dt>File</dt><dd className="ellipsis">{comic.fileName}</dd></div>
        </dl>

        {adding && <AddToCollection comicIds={[comic.id]} onClose={() => setAdding(false)} notify={notify} />}
      </div>
    </div>
  );
}

function EditForm({ comic, onDone }: { comic: Comic; onDone: () => void }) {
  const [f, setF] = useState({
    title: comic.title,
    series: comic.series,
    number: comic.number ?? '',
    volume: comic.volume ?? '',
    year: comic.year ? String(comic.year) : '',
    publisher: comic.publisher ?? '',
    writer: comic.writer ?? '',
    artist: comic.artist ?? '',
  });
  const field = (k: keyof typeof f, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <form
      className="edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        void updateComic(comic.id, {
          ...f,
          number: f.number || undefined,
          volume: f.volume || undefined,
          year: Number(f.year) || undefined,
          publisher: f.publisher || undefined,
          writer: f.writer || undefined,
          artist: f.artist || undefined,
        }).then(onDone);
      }}
    >
      {field('title', 'Title')}
      {field('series', 'Series')}
      <div className="row gap">{field('number', 'Issue #')}{field('volume', 'Volume')}{field('year', 'Year')}</div>
      {field('publisher', 'Publisher')}
      <div className="row gap">{field('writer', 'Writer')}{field('artist', 'Artist')}</div>
      <div className="row gap end">
        <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary">Save</button>
      </div>
    </form>
  );
}
