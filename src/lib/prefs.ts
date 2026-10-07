import { useSyncExternalStore } from 'react';
import type { Direction, ReadMode } from '../db';
import { markDirty } from './syncState';

export type Fit = 'screen' | 'width' | 'height' | 'original';
export type Transition = 'slide' | 'turn' | 'fade' | 'none';
export type Background = 'black' | 'gray' | 'white' | 'sepia';
export type TapZones = 'edges' | 'halves' | 'off';

export interface Prefs {
  readMode: ReadMode;
  direction: Direction;
  autoMangaDirection: boolean; // honour ComicInfo / EPUB right-to-left hints
  fit: Fit;
  transition: Transition;
  background: Background;
  tapZones: TapZones;
  invertTaps: boolean;
  doubleCoverAlone: boolean;
  scrollGap: number;
  scrollWidth: number; // % of screen width used in vertical scroll mode (desktop)
  brightness: number; // 40..120 (%)
  warmth: number; // 0..100 — night-reading sepia overlay
  alwaysShowPageNumber: boolean; // otherwise it shows only with the reader controls
  keepAwake: boolean;
  autoCrop: boolean; // trim scanner borders / white margins
  guidedShowFullPageFirst: boolean;
  theme: 'dark' | 'light' | 'system';
  upNextHidden: string[]; // "afterId>nextId" suggestions you removed from Up next (synced with prefs)
  groupOrder: Record<string, string[]>; // your order inside Series groups = reading order (synced with prefs)
}

export const DEFAULT_PREFS: Prefs = {
  readMode: 'paged',
  direction: 'ltr',
  autoMangaDirection: true,
  fit: 'screen',
  transition: 'slide',
  background: 'black',
  tapZones: 'edges',
  invertTaps: false,
  doubleCoverAlone: true,
  scrollGap: 0,
  scrollWidth: 100,
  brightness: 100,
  warmth: 0,
  alwaysShowPageNumber: false,
  keepAwake: true,
  autoCrop: false,
  guidedShowFullPageFirst: true,
  theme: 'dark',
  upNextHidden: [],
  groupOrder: {},
};

const KEY = 'prefs.v1';
const listeners = new Set<() => void>();

function load(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let current = load();

export const getPrefs = () => current;

export function getPrefsUpdatedAt(): number {
  try {
    return Number(localStorage.getItem(`${KEY}.updatedAt`)) || 0;
  } catch {
    return 0;
  }
}

/** Pass updatedAt when applying synced prefs so we don't echo them back as a new change. */
export function setPrefs(patch: Partial<Prefs>, updatedAt?: number) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    localStorage.setItem(`${KEY}.updatedAt`, String(updatedAt ?? Date.now()));
  } catch {}
  listeners.forEach((l) => l());
  if (updatedAt === undefined) markDirty();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
