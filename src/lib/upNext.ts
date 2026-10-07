import type { Collection, Comic, Progress } from '../db';
import { buildTree, type GroupOrder } from './folders';
import { isReadable, sortComics, statusOf } from './library';

export interface UpNextItem {
  comic: Comic; // the immediate next issue
  after: Comic; // the comic you finished that leads to it
  via: string; // where the order comes from: a collection, a series folder, or the series name
}

/**
 * One suggestion per series you've finished something in: the issue right after the
 * comic you most recently finished there, newest first. Order comes from (1) a reading-list
 * collection holding that comic, (2) its series in the folder-aware Series view (so Vol. 1 #7
 * leads into Vol. 2 #8), or (3) series + issue number. A series is left out when its next
 * issue is already in progress (it's in "Continue reading") or when you've finished it all.
 */
export const upNextKey = (afterId: string, nextId: string) => `${afterId}>${nextId}`;

export function computeUpNext(
  comics: Comic[],
  progress: Map<string, Progress>,
  collections: Collection[],
  hidden: string[] = [],
  order: GroupOrder = {},
  limit = 12,
): UpNextItem[] {
  const hiddenSet = new Set(hidden);
  const finished = comics
    .filter((c) => progress.get(c.id)?.finished)
    .sort((a, b) => (progress.get(b.id)?.lastReadAt ?? 0) - (progress.get(a.id)?.lastReadAt ?? 0));
  if (!finished.length) return [];

  const byId = new Map(comics.map((c) => [c.id, c]));
  const lists = collections.filter((col) => !col.smart && !col.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  const seriesNodes = buildTree(comics, order).folders;

  const out: UpNextItem[] = [];
  const doneSequences = new Set<string>();
  const suggested = new Set<string>();

  for (const after of finished) {
    let key: string;
    let via: string;
    let sequence: () => Comic[];
    const list = lists.find((col) => col.comicIds.includes(after.id));
    const node = list ? undefined : seriesNodes.find((n) => n.all.length > 1 && n.all.some((c) => c.id === after.id));
    if (list) {
      key = `col:${list.id}`;
      via = list.name;
      sequence = () => list.comicIds.map((id) => byId.get(id)).filter(Boolean) as Comic[];
    } else if (node) {
      key = `node:${node.key}`;
      via = node.name;
      sequence = () => node.all;
    } else {
      key = `series:${after.series.toLowerCase()}`;
      via = after.series;
      sequence = () => sortComics(comics.filter((c) => c.series === after.series), 'series');
    }
    // Only the most recently finished comic in each series decides its suggestion.
    if (doneSequences.has(key)) continue;
    doneSequences.add(key);

    const seq = sequence();
    const i = seq.findIndex((c) => c.id === after.id);
    const next = seq.slice(i + 1).find((c) => statusOf(progress.get(c.id)) !== 'finished' && isReadable(c));
    if (!next || statusOf(progress.get(next.id)) === 'reading' || suggested.has(next.id)) continue;
    // you removed this suggestion; it comes back as a new one once you finish another issue here
    if (hiddenSet.has(upNextKey(after.id, next.id))) continue;
    suggested.add(next.id);
    out.push({ comic: next, after, via });
    if (out.length >= limit) break;
  }
  return out;
}
