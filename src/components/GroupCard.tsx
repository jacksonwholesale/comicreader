import { Check } from 'lucide-react';
import { useRef } from 'react';
import type { Progress } from '../db';
import type { FolderNode } from '../lib/folders';
import { statusOf } from '../lib/library';
import { Cover } from './ComicCard';

interface Props {
  group: FolderNode;
  progress: Map<string, Progress>;
  onOpen: () => void;
  onMenu?: (x: number, y: number) => void;
  /** select mode: tapping toggles the whole group */
  selecting?: boolean;
  selected?: 'all' | 'some' | 'none';
  onToggle?: () => void;
}

/** A stacked-covers card for a group (series / folder); right-click / long-press for its menu. */
export function GroupCard({ group: f, progress, onOpen, onMenu, selecting, selected = 'none', onToggle }: Props) {
  const timer = useRef<number>(undefined);
  const longPressed = useRef(false);
  const read = f.all.filter((c) => statusOf(progress.get(c.id)) === 'finished').length;
  return (
    <button
      className={`card series-card${selected === 'all' ? ' selected' : ''}`}
      onClick={() => {
        if (longPressed.current) longPressed.current = false;
        else if (selecting) onToggle?.();
        else onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (longPressed.current) return;
        if (selecting) onToggle?.();
        else onMenu?.(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.pointerType !== 'touch' || selecting || !onMenu) return;
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
        {selecting && <span className={`select-tick${selected !== 'none' ? ' on' : ''}`}>{selected !== 'none' && <Check size={14} />}</span>}
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
