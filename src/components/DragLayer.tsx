import { useEffect } from 'react';
import { useDragState } from '../lib/dnd';
import { Cover } from './ComicCard';

/** The cover that follows your finger/pointer while dragging, and the highlight on the target under it. */
export function DragLayer() {
  const drag = useDragState();
  const over = drag?.over ?? null;

  useEffect(() => {
    if (!over) return;
    const el = document.querySelector(`[data-drop="${CSS.escape(over)}"]`);
    el?.classList.add('drop-over');
    return () => el?.classList.remove('drop-over');
  }, [over]);

  if (!drag) return null;
  const { payload, x, y } = drag;
  return (
    <div className="drag-ghost" style={{ transform: `translate(${x - 36}px, ${y - 54}px)` }}>
      {payload.cover && <Cover comic={payload.cover} />}
      <span className="drag-label">
        {payload.kind === 'group' ? `${payload.label} · ${payload.ids.length}` : payload.label}
      </span>
    </div>
  );
}
