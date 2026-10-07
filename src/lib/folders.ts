import type { Comic } from '../db';
import { sortComics } from './library';

/**
 * The Series view as a tree. Where a comic sits:
 *  1. your own arrangement (`shelf`, set by renaming/moving in the app) — always wins
 *  2. its folders in a linked Drive folder
 *  3. otherwise its series name
 * Sibling Drive folders that are volumes of one series ("Batman, Vol. 1: …", "Batman, Vol. 2: …")
 * are gathered under a series node automatically; your own arrangement is never regrouped.
 */
export interface FolderNode {
  key: string; // stable path key, used for navigation
  name: string;
  path: string[]; // names from the top of the library down to this node
  folders: FolderNode[];
  comics: Comic[];
  all: Comic[]; // every comic in this subtree, in reading order
  custom: boolean; // contains comics you've arranged yourself
  /** groups and comics in display = reading order (your custom order if you've set one) */
  items: TreeItem[];
}

export type TreeItem = { id: string; kind: 'group'; node: FolderNode } | { id: string; kind: 'comic'; comic: Comic };

/** Custom order per group: group key → item ids ("g:<name>" for sub-groups, "c:<comic id>" for comics). */
export type GroupOrder = Record<string, string[]>;
export const groupItemId = (node: FolderNode) => `g:${node.name.toLowerCase()}`;
export const comicItemId = (c: Comic) => `c:${c.id}`;

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
  custom: boolean;
}

const raw = (name: string): Raw => ({ name, folders: new Map(), comics: [], custom: false });

export function placeOf(c: Comic): string[] {
  if (c.shelf) return c.shelf; // your arrangement; [] = loose at the top level
  if (c.drivePath?.length) return c.drivePath;
  // Loose in a linked Drive folder: loose here too, like in Drive. (Guessing a series name used to
  // merge these into any real folder that happened to share the name.)
  if (c.driveFolderId) return [];
  return [c.series || 'Unsorted']; // comics imported on a device: by series name
}

export function buildTree(comics: Comic[], order: GroupOrder = {}): FolderNode {
  const root = raw('Library');
  for (const c of comics) {
    const custom = c.shelf !== undefined;
    let node = root;
    for (const seg of placeOf(c)) {
      let next = node.folders.get(seg.toLowerCase());
      if (!next) node.folders.set(seg.toLowerCase(), (next = raw(seg)));
      node = next;
      if (custom) node.custom = true;
    }
    node.comics.push(c);
  }
  return finish(root, '', [], order);
}

function groupVolumes(node: Raw, isRoot: boolean) {
  if (node.custom && !isRoot) return; // you arranged this level yourself
  const bySeries = new Map<string, Raw[]>();
  for (const f of node.folders.values()) {
    if (f.custom) continue;
    const s = volumeSeries(f.name);
    if (s) bySeries.set(s.toLowerCase(), [...(bySeries.get(s.toLowerCase()) ?? []), f]);
  }
  for (const [key, vols] of bySeries) {
    // Already inside that series' node (we just grouped these, or the Drive folder is named after it).
    if (node.name.toLowerCase() === key) continue;
    // Only gather several volumes into a new group of their own; never pour them into an existing
    // folder that happens to share the series name (that's how things ended up with unrelated books).
    if (vols.length < 2 || node.folders.has(key)) continue;
    const parent = raw(volumeSeries(vols[0].name)!);
    for (const v of vols) {
      if (v === parent) continue;
      node.folders.delete(v.name.toLowerCase());
      parent.folders.set(v.name.toLowerCase(), v);
    }
    node.folders.set(key, parent);
  }
}

function finish(node: Raw, parentKey: string, parentPath: string[], order: GroupOrder): FolderNode {
  groupVolumes(node, !parentKey);
  const key = parentKey ? `${parentKey}/${node.name}` : node.name;
  const path = parentKey ? [...parentPath, node.name] : [];
  const folders = [...node.folders.values()].sort((a, b) => collator.compare(a.name, b.name)).map((f) => finish(f, key, path, order));
  const comics = sortComics(node.comics, 'series');
  // default: sub-groups (by name) then comics (by series/issue); your saved order wins, and anything
  // new that isn't in it yet keeps its default place at the end
  let items: TreeItem[] = [
    ...folders.map((f) => ({ id: groupItemId(f), kind: 'group' as const, node: f })),
    ...comics.map((c) => ({ id: comicItemId(c), kind: 'comic' as const, comic: c })),
  ];
  const saved = order[key];
  if (saved?.length) {
    const rank = new Map(saved.map((id, i) => [id, i]));
    items = items
      .map((it, i) => ({ it, r: rank.get(it.id) ?? saved.length + i }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.it);
  }
  return {
    key,
    name: node.name,
    path,
    folders,
    comics,
    items,
    all: items.flatMap((it) => (it.kind === 'group' ? it.node.all : [it.comic])),
    custom: node.custom || folders.some((f) => f.custom),
  };
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

/** Where each comic is shown (group names from the top), including automatic volume grouping. */
export function shownPaths(root: FolderNode): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (n: FolderNode) => {
    for (const c of n.comics) out.set(c.id, n.path);
    n.folders.forEach(walk);
  };
  walk(root);
  return out;
}

/** Every group as a flat list (for "Move to…"), depth-first. */
export function allGroups(root: FolderNode): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (n: FolderNode) => {
    for (const f of n.folders) {
      out.push(f);
      walk(f);
    }
  };
  walk(root);
  return out;
}
