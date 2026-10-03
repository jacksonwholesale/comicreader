import { useRef, useSyncExternalStore, type MouseEvent, type PointerEvent } from 'react';
import type { Comic } from '../db';

/**
 * Drag and drop for comics and series stacks, working with a mouse and with touch.
 *  - mouse: press and move a few pixels to start dragging; right-click for the menu
 *  - touch: press and hold, then move to drag; hold without moving for the menu
 * Drop targets are any element with data-drop="<target id>" (e.g. "col:abc", "group:Library/Batman", "newcol").
 */

export type DragPayload =
  | { kind: 'comics'; ids: string[]; label: string; cover?: Comic }
  | { kind: 'group'; key: string; ids: string[]; label: string; cover?: Comic };

interface DragState {
  payload: DragPayload;
  x: number;
  y: number;
  over: string | null;
}

let state: DragState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let dropHandler: ((p: DragPayload, target: string) => void) | null = null;

/** The screen that owns the drop targets registers what a drop does. */
export function setDropHandler(fn: typeof dropHandler) {
  dropHandler = fn;
}

export function useDragState() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

function targetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null;
  return el?.dataset.drop ?? null;
}

// While a touch is held (armed) or dragging, stop the page from scrolling under the finger;
// otherwise Safari/Chrome would take the movement as a scroll and cancel the drag.
let touchLock = false;
function blockScroll(e: TouchEvent) {
  if (state || touchLock) e.preventDefault();
}
function lockTouch(on: boolean) {
  touchLock = on;
  if (on) document.addEventListener("touchmove", blockScroll, { passive: false });
  else if (!state) document.removeEventListener("touchmove", blockScroll);
}

// Dragging near the top/bottom edge scrolls the page, so targets off screen can be reached.
let scrollRaf = 0;
function autoScroll() {
  cancelAnimationFrame(scrollRaf);
  if (!state) return;
  const edge = 70;
  const { y } = state;
  const speed = y < edge ? -(edge - y) / 3 : y > innerHeight - edge ? (y - (innerHeight - edge)) / 3 : 0;
  if (speed) {
    const scroller = (document.querySelector('.main') as HTMLElement | null) ?? document.scrollingElement;
    scroller?.scrollBy(0, speed);
    state = { ...state, over: targetAt(state.x, state.y) };
    emit();
    scrollRaf = requestAnimationFrame(autoScroll);
  }
}

function begin(payload: DragPayload, x: number, y: number) {
  state = { payload, x, y, over: targetAt(x, y) };
  document.addEventListener('touchmove', blockScroll, { passive: false });
  document.body.classList.add('dragging');
  navigator.vibrate?.(15);
  emit();
}

function move(x: number, y: number) {
  if (!state) return;
  state = { ...state, x, y, over: targetAt(x, y) };
  emit();
  autoScroll();
}

function finish(drop: boolean) {
  if (!state) return;
  const { payload, over } = state;
  state = null;
  cancelAnimationFrame(scrollRaf);
  if (!touchLock) document.removeEventListener('touchmove', blockScroll);
  document.body.classList.remove('dragging');
  emit();
  if (drop && over) dropHandler?.(payload, over);
}

/**
 * Tap / menu / drag handling for a card. Spread `handlers` on the card's button.
 * getPayload returns what's being dragged, or null when this card can't be dragged.
 */
export function usePressDrag({
  onTap,
  onMenu,
  getPayload,
}: {
  onTap: () => void;
  onMenu?: (x: number, y: number) => void;
  getPayload?: () => DragPayload | null;
}) {
  const g = useRef<{
    id: number;
    x: number;
    y: number;
    touch: boolean;
    armed: boolean; // touch: held long enough
    dragging: boolean;
    timer?: number;
    suppressClick: boolean;
  } | null>(null);
  const suppress = useRef(false);

  const cleanup = () => {
    lockTouch(false);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onMove = (e: globalThis.PointerEvent) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    const dist = Math.hypot(e.clientX - s.x, e.clientY - s.y);
    if (s.dragging) return move(e.clientX, e.clientY);
    if (s.touch && !s.armed) {
      // moved before the hold finished: it's a scroll, not a drag
      if (dist > 10) {
        clearTimeout(s.timer);
        g.current = null;
        cleanup();
      }
      return;
    }
    if (dist > (s.touch ? 8 : 6)) {
      const p = getPayload?.();
      if (!p) return;
      s.dragging = true;
      clearTimeout(s.timer);
      begin(p, e.clientX, e.clientY);
    }
  };
  const onUp = (e: globalThis.PointerEvent) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    clearTimeout(s.timer);
    cleanup();
    g.current = null;
    if (s.dragging) {
      suppress.current = true;
      finish(true);
    } else if (s.touch && s.armed) {
      // held without moving: the menu
      suppress.current = true;
      onMenu?.(s.x, s.y);
    }
  };
  const onCancel = (e: globalThis.PointerEvent) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    clearTimeout(s.timer);
    cleanup();
    g.current = null;
    if (s.dragging) finish(false);
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      const touch = e.pointerType !== 'mouse';
      g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, armed: !touch, dragging: false, suppressClick: false };
      if (touch)
        g.current.timer = window.setTimeout(() => {
          if (g.current) {
            g.current.armed = true;
            lockTouch(true);
            navigator.vibrate?.(10);
          }
        }, 380);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    onClick: () => {
      if (suppress.current) {
        suppress.current = false;
        return;
      }
      onTap();
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      // touch long-press is handled above (it may become a drag instead)
      if (g.current?.touch || suppress.current) return;
      onMenu?.(e.clientX, e.clientY);
    },
    draggable: false,
  };
}
