import { Check, CloudDownload, Heart } from 'lucide-react';
import { useRef } from 'react';
import type { Comic, Progress } from '../db';
import { useBlobUrl } from '../lib/hooks';
import { percentOf, statusOf } from '../lib/library';

interface Props {
  comic: Comic;
  progress?: Progress;
  selected?: boolean;
  selecting?: boolean;
  onOpen: () => void;
  onSelect: () => void;
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

export function ComicCard({ comic, progress, selected, selecting, onOpen, onSelect, subtitle }: Props) {
  const status = statusOf(progress);
  const pct = percentOf(progress, comic);
  const pressTimer = useRef<number>(undefined);
  const longPressed = useRef(false);
  return (
    <button
      className={`card${selected ? ' selected' : ''}${!comic.hasFile ? ' remote' : ''}`}
      onClick={() => {
        if (longPressed.current) return void (longPressed.current = false);
        selecting ? onSelect() : onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!longPressed.current) onSelect();
      }}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.pointerType === 'touch')
          pressTimer.current = window.setTimeout(() => {
            longPressed.current = true;
            onSelect();
          }, 450);
      }}
      onPointerUp={() => clearTimeout(pressTimer.current)}
      onPointerLeave={() => clearTimeout(pressTimer.current)}
      onPointerCancel={() => clearTimeout(pressTimer.current)}
      title={comic.title}
    >
      <div className="card-cover">
        <Cover comic={comic} />
        {status === 'unread' && <span className="dot-new" aria-label="Unread" />}
        {status === 'finished' && <span className="badge-done"><Check size={14} /></span>}
        {!comic.hasFile && <span className="badge-cloud" title="In Google Drive — not downloaded"><CloudDownload size={14} /></span>}
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
