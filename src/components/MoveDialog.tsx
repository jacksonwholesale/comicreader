import { Folder, FolderPlus, X } from 'lucide-react';
import { useState } from 'react';
import { allGroups, type FolderNode } from '../lib/folders';

interface Props {
  title: string;
  tree: FolderNode;
  /** when moving a group: it (and what's inside it) can't be the destination */
  excludeKey?: string;
  /** offer "Top of library" (moving a group out of its parent) */
  allowTop?: boolean;
  onPick: (path: string[]) => void;
  onClose: () => void;
}

/** Pick a group in the Series view to move comics (or a group) into — or name a new one. */
export function MoveDialog({ title, tree, excludeKey, allowTop, onPick, onClose }: Props) {
  const [name, setName] = useState('');
  const groups = allGroups(tree).filter((g) => !excludeKey || (g.key !== excludeKey && !g.key.startsWith(`${excludeKey}/`)));
  const pick = (path: string[]) => {
    onPick(path);
    onClose();
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="sheet small-sheet move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) pick([name.trim()]);
          }}
        >
          <input className="input grow" placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!name.trim()}><FolderPlus size={18} /> New</button>
        </form>
        <div className="list">
          {allowTop && (
            <button className="list-row" onClick={() => pick([])}>
              <Folder size={18} className="muted" />
              <span className="grow">Top of library</span>
            </button>
          )}
          {groups.map((g) => (
            <button key={g.key} className="list-row" style={{ paddingLeft: 12 + (g.path.length - 1) * 18 }} onClick={() => pick(g.path)}>
              <Folder size={18} className="accent" />
              <span className="grow ellipsis">{g.name}</span>
              <span className="muted small">{g.all.length}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
