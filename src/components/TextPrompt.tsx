import { X } from 'lucide-react';
import { useState } from 'react';

interface Props {
  title: string;
  label?: string;
  initial?: string;
  confirm?: string;
  hint?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** Small "type a name" dialog (rename a group, a collection, …). */
export function TextPrompt({ title, label, initial = '', confirm = 'Save', hint, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="sheet small-sheet prompt"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onSubmit(value.trim());
          onClose();
        }}
      >
        <div className="sheet-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="prompt-body">
          <label className="field">
            {label && <span>{label}</span>}
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
          </label>
          {hint && <p className="muted small">{hint}</p>}
          <div className="row gap end">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!value.trim()}>{confirm}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
