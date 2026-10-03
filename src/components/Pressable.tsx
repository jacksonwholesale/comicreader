import { useRef, type ReactNode } from 'react';

/** A button where tap opens, and right-click / long-press (touch) opens a menu instead. */
export function Pressable({
  className,
  onOpen,
  onMenu,
  children,
  drop,
}: {
  className?: string;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  children: ReactNode;
  /** drop-target id (see lib/dnd) */
  drop?: string;
}) {
  const timer = useRef<number>(undefined);
  const longPressed = useRef(false);
  return (
    <button
      className={className}
      data-drop={drop}
      onClick={() => {
        if (longPressed.current) longPressed.current = false;
        else onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!longPressed.current) onMenu(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.pointerType !== 'touch') return;
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
      {children}
    </button>
  );
}
