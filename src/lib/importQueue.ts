import { useSyncExternalStore } from 'react';
import { importFiles, toImportItems, type ImportResult, type PickedFile } from './importer';

export interface ImportState {
  running: boolean;
  done: number;
  total: number;
  current: string;
  last?: ImportResult;
}

let state: ImportState = { running: false, done: 0, total: 0, current: '' };
const listeners = new Set<() => void>();
const set = (s: Partial<ImportState>) => {
  state = { ...state, ...s };
  listeners.forEach((l) => l());
};
let chain = Promise.resolve();

export function queueImport(files: PickedFile[]) {
  const items = toImportItems(files);
  if (!items.length) {
    set({ last: { added: 0, skipped: 0, failed: [{ name: 'Nothing to import', error: 'No comic files or images found' }] } });
    return;
  }
  if (!state.running) set({ last: undefined, done: 0, total: 0 });
  set({ running: true, total: state.total + items.length });
  chain = chain.then(async () => {
    const start = state.done;
    const result = await importFiles(items, (done, _t, name) => set({ done: start + done, current: name }));
    const prev = state.last ?? { added: 0, skipped: 0, failed: [] };
    set({
      last: { added: prev.added + result.added, skipped: prev.skipped + result.skipped, failed: [...prev.failed, ...result.failed] },
    });
    if (state.done >= state.total) set({ running: false, current: '' });
  });
  return chain;
}

export function clearImportResult() {
  set({ last: undefined });
}

export function useImportState() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
