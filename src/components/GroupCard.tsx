import { Check } from 'lucide-react';
import type { Progress } from '../db';
import type { FolderNode } from '../lib/folders';
import { statusOf } from '../lib/library';
import { usePressDrag } from '../lib/dnd';
import { Cover } from './ComicCard';

interface Props {
  group: FolderNode;
  progress: Map<string, Progress>;
  onOpen: () => void;
  onMenu?: (x: number, y: number) => void;
  /** other things can be dropped onto this group (moves them into it) */
  dropTarget?: boolean;
  /** select mode: tapping toggles the whole group */
  selecting?: boolean;
  selected?: 'all' | 'some' | 'none';
  onToggle?: () => void;
}

/** A stacked-covers card for a group (series / folder); right-click / long-press for its menu. */
export function GroupCard({ group: f, progress, onOpen, onMenu, dropTarget, selecting, selected = 'none', onToggle }: Props) {
  const press = usePressDrag({
    onTap: () => (selecting ? onToggle?.() : onOpen()),
    onMenu: (x, y) => (selecting ? onToggle?.() : onMenu?.(x, y)),
    getPayload: () => (selecting ? null : { kind: 'group', key: f.key, ids: f.all.map((c) => c.id), label: f.name, cover: f.all[0] }),
  });
  const read = f.all.filter((c) => statusOf(progress.get(c.id)) === 'finished').length;
  return (
    <button
      className={`card series-card${selected === 'all' ? ' selected' : ''}`}
      data-drop={dropTarget ? `group:${f.key}` : undefined}
      {...press}
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
