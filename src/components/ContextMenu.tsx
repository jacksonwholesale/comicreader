import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onClick: () => void;
}

/** Small right-click / long-press menu, kept on screen and closed by any outside tap, Esc or scroll. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    // defer so the long-press/right-click that opened us doesn't immediately close it
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close, true);
      window.addEventListener('keydown', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
    });
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? 'danger' : ''}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}
