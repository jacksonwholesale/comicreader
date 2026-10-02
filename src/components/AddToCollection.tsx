import { Check, Cloud, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { addToCollection, createCollection } from '../lib/library';
import { useLibrary } from '../lib/useLibrary';

interface Props {
  comicIds: string[];
  onClose: () => void;
  notify: (msg: string) => void;
}

export function AddToCollection({ comicIds, onClose, notify }: Props) {
  const { collections } = useLibrary();
  const [name, setName] = useState('');
  const manual = collections.filter((c) => !c.smart).sort((a, b) => b.updatedAt - a.updatedAt);
  const add = async (id: string, label: string) => {
    await addToCollection(id, comicIds);
    notify(`Added ${comicIds.length > 1 ? `${comicIds.length} comics ` : ''}to ${label}`);
    onClose();
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="sheet small-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>Add to collection</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <form
          className="row gap"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const id = await createCollection(name);
            await add(id, name.trim());
          }}
        >
          <input className="input grow" placeholder="New collection name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button className="btn primary" type="submit" disabled={!name.trim()}><Plus size={18} /> Create</button>
        </form>
        <div className="list">
          {manual.map((c) => {
            const all = comicIds.every((id) => c.comicIds.includes(id));
            return (
              <button key={c.id} className="list-row" onClick={() => void add(c.id, c.name)} disabled={all}>
                <span className="grow">{c.name}</span>
                {c.driveSync ? <Cloud size={16} className="muted" /> : null}
                <span className="muted small">{c.comicIds.length}</span>
                {all && <Check size={16} className="accent" />}
              </button>
            );
          })}
          {!manual.length && <p className="muted small">No collections yet — create one above.</p>}
        </div>
      </div>
    </div>
  );
}
