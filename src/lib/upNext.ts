import type { Collection, Comic, Progress } from '../db';
import { buildTree } from './folders';
import { sortComics, statusOf } from './library';

export interface UpNext {
  after: Comic; // the comic you most recently finished
  via: string; // where the order comes from: a collection, a series folder, or the series name
  items: Comic[]; // what comes next, in order
}

/**
 * What to read after your most recently finished comic. Order comes from
 * (1) a reading-list collection holding it, (2) its series in the folder-aware Series view
 * (so Vol. 1 #7 leads into Vol. 2 #8), or (3) series + issue number.
 * Skips comics already finished or in progress (those live in "Continue reading").
 */
export function computeUpNext(comics: Comic[], progress: Map<string, Progress>, collections: Collection[], limit = 8): UpNext | null {
  let after: Comic | undefined;
  let latest = 0;
  for (const c of comics) {
    const p = progress.get(c.id);
    if (p?.finished && p.lastReadAt > latest) {
      latest = p.lastReadAt;
      after = c;
    }
  }
  if (!after) return null;

  const list = collections
    .filter((col) => !col.smart && !col.deleted && col.comicIds.includes(after!.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  let sequence: Comic[];
  let via: string;
  if (list) {
    const byId = new Map(comics.map((c) => [c.id, c]));
    sequence = list.comicIds.map((id) => byId.get(id)).filter(Boolean) as Comic[];
    via = list.name;
  } else {
    const node = buildTree(comics).folders.find((n) => n.all.some((c) => c.id === after!.id));
    if (node && node.all.length > 1) {
      sequence = node.all;
      via = node.name;
    } else {
      sequence = sortComics(
        comics.filter((c) => c.series === after!.series),
        'series',
      );
      via = after.series;
    }
  }

  const i = sequence.findIndex((c) => c.id === after!.id);
  const items = sequence
    .slice(i + 1)
    .filter((c) => statusOf(progress.get(c.id)) === 'unread')
    .slice(0, limit);
  return items.length ? { after, via, items } : null;
}
