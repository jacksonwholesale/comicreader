import { Check, CloudDownload, CloudOff, Heart } from 'lucide-react';
import type { Comic, Progress } from '../db';
import { useBlobUrl } from '../lib/hooks';
import { percentOf, statusOf } from '../lib/library';
import { usePressDrag } from '../lib/dnd';

interface Props {
  comic: Comic;
  progress?: Progress;
  selected?: boolean;
  selecting?: boolean;
  onOpen: () => void;
  onSelect: () => void;
  /** When given, right-click / long-press opens a menu at that point instead of onSelect. */
  onMenu?: (x: number, y: number) => void;
  subtitle?: string;
}

export function Cover({ comic, className = '' }: { comic: Comic; className?: string }) {
  const url = useBlobUrl(comic.cover);
  const src = url ?? comic.coverTiny;
  return (
    <div className={`cover ${className}`}>
      {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : <div className="cover-blank">{comic.title.slice(0, 2)}</div>}
    </div>
  );
}

export function ComicCard({ comic, progress, selected, selecting, onOpen, onSelect, onMenu, subtitle }: Props) {
  const status = statusOf(progress);
  const pct = percentOf(progress, comic);
  // tap opens; right-click / hold for the menu; drag onto a collection or group
  const press = usePressDrag({
    onTap: () => (selecting ? onSelect() : onOpen()),
    onMenu: (x, y) => (onMenu && !selecting ? onMenu(x, y) : onSelect()),
    getPayload: () => (selecting ? null : { kind: 'comics', ids: [comic.id], label: comic.title, cover: comic }),
  });
  return (
    <button
      className={`card${selected ? ' selected' : ''}${!comic.hasFile ? ' remote' : ''}${comic.driveMissing ? ' missing' : ''}`}
      {...press}
      title={comic.title}
    >
      <div className="card-cover">
        <Cover comic={comic} />
        {status === 'unread' && <span className="dot-new" aria-label="Unread" />}
        {status === 'finished' && <span className="badge-done"><Check size={14} /></span>}
        {comic.driveMissing ? (
          <span className="badge-missing" title={comic.hasFile ? 'Removed from Google Drive (still downloaded here)' : 'Removed from Google Drive'}>
            <CloudOff size={14} />
          </span>
        ) : (
          !comic.hasFile && <span className="badge-cloud" title="In Google Drive — not downloaded"><CloudDownload size={14} /></span>
        )}
        {comic.favorite ? <span className="badge-fav"><Heart size={12} fill="currentColor" /></span> : null}
        {status === 'reading' && (
          <div className="progress-bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
        {selecting && <span className={`select-tick${selected ? ' on' : ''}`}>{selected && <Check size={14} />}</span>}
      </div>
      <div className="card-meta">
        <strong>{comic.title}</strong>
        <span>{subtitle ?? (status === 'reading' ? `${pct}% · page ${(progress?.page ?? 0) + 1}/${comic.pageCount}` : comic.series)}</span>
      </div>
    </button>
  );
}
