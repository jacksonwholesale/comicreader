import type { Comic } from '../db';
import { sortComics } from './library';

/**
 * The Series view as a tree. Comics from linked Drive folders keep their folder structure;
 * comics outside folders (local imports, files at a linked folder's top level) group by series name.
 * Sibling folders that are volumes of the same series ("Batman, Vol. 1: …", "Batman, Vol. 2: …")
 * are gathered under one series node.
 */
export interface FolderNode {
  key: string; // stable path key, used for navigation
  name: string;
  folders: FolderNode[];
  comics: Comic[];
  all: Comic[]; // every comic in this subtree, in reading order
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "Batman, Vol. 2: The City of Owls" → "Batman"; null if the name isn't a volume of something. */
export function volumeSeries(name: string): string | null {
  const m = name.match(/^(.*?)[\s,:–-]*\b(?:vol(?:ume)?\.?|v)\s*\d+\b/i);
  const series = m?.[1].trim();
  return series ? series : null;
}

interface Raw {
  name: string;
  folders: Map<string, Raw>;
  comics: Comic[];
}

const raw = (name: string): Raw => ({ name, folders: new Map(), comics: [] });

export function buildTree(comics: Comic[]): FolderNode {
  const root = raw('Library');
  for (const c of comics) {
    const path = c.drivePath?.length ? c.drivePath : [c.series || 'Unsorted'];
    let node = root;
    for (const seg of path) {
      let next = node.folders.get(seg.toLowerCase());
      if (!next) node.folders.set(seg.toLowerCase(), (next = raw(seg)));
      node = next;
    }
    node.comics.push(c);
  }
  return finish(root, '');
}

function groupVolumes(node: Raw) {
  const bySeries = new Map<string, Raw[]>();
  for (const f of node.folders.values()) {
    const s = volumeSeries(f.name);
    if (s) bySeries.set(s.toLowerCase(), [...(bySeries.get(s.toLowerCase()) ?? []), f]);
  }
  for (const [key, vols] of bySeries) {
    // Already inside that series' node (we just grouped these, or the Drive folder is named after it).
    if (node.name.toLowerCase() === key) continue;
    const existing = node.folders.get(key);
    // Group when there are several volumes, or a folder/series of that exact name already exists.
    if (vols.length < 2 && !existing) continue;
    const parent = existing ?? raw(volumeSeries(vols[0].name)!);
    for (const v of vols) {
      if (v === parent) continue;
      node.folders.delete(v.name.toLowerCase());
      parent.folders.set(v.name.toLowerCase(), v);
    }
    node.folders.set(key, parent);
  }
}

function finish(node: Raw, parentKey: string): FolderNode {
  groupVolumes(node);
  const key = parentKey ? `${parentKey}/${node.name}` : node.name;
  const folders = [...node.folders.values()].sort((a, b) => collator.compare(a.name, b.name)).map((f) => finish(f, key));
  const comics = sortComics(node.comics, 'series');
  return { key, name: node.name, folders, comics, all: [...folders.flatMap((f) => f.all), ...comics] };
}

/** Follow a list of node keys from the root; stops at the deepest one that still exists. */
export function findPath(root: FolderNode, keys: string[]): FolderNode[] {
  const trail = [root];
  for (const k of keys) {
    const next = trail[trail.length - 1].folders.find((f) => f.key === k);
    if (!next) break;
    trail.push(next);
  }
  return trail;
}
