import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useSyncExternalStore } from 'react';
import { db, type Collection, type Comic, type Progress } from '../db';
import { getSyncStatus, getTransfers, subscribeSync } from './sync';

export function useLibrary() {
  const comics = useLiveQuery(() => db.comics.filter((c) => !c.deleted).toArray(), [], undefined as Comic[] | undefined);
  const progressList = useLiveQuery(() => db.progress.toArray(), [], [] as Progress[]);
  const collections = useLiveQuery(() => db.collections.filter((c) => !c.deleted).toArray(), [], [] as Collection[]);
  const progress = useMemo(() => new Map(progressList.map((p) => [p.comicId, p])), [progressList]);
  return { comics, progress, collections, loading: comics === undefined };
}

export function useSyncStatus() {
  return useSyncExternalStore(subscribeSync, getSyncStatus);
}

export function useTransfers() {
  return useSyncExternalStore(subscribeSync, getTransfers);
}
