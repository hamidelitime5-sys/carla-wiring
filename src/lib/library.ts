// src/lib/library.ts : « Mes chaînes » : une bibliothèque de patchbays nommés (enregistrer, charger, dupliquer, échanger).
import type { PatchProject } from './carxp';

export interface SavedChain {
  id: string;
  name: string;
  savedAt: string; // date ISO
  project: PatchProject;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function isProject(p: unknown): p is PatchProject {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return Array.isArray(o.nodes) && Array.isArray(o.cables) && typeof o.hardware === 'object' && o.hardware !== null;
}

export function parseLibrary(data: unknown): SavedChain[] {
  const arr = Array.isArray(data) ? data : (typeof data === 'object' && data !== null ? (data as { chains?: unknown }).chains : undefined);
  if (!Array.isArray(arr)) return [];
  const out: SavedChain[] = [];
  for (const x of arr) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.name === 'string' && o.name.trim() && isProject(o.project)) {
      out.push({ id: typeof o.id === 'string' && o.id ? o.id : `c${out.length + 1}`, name: o.name.trim(), savedAt: typeof o.savedAt === 'string' ? o.savedAt : '', project: o.project });
    }
  }
  return out;
}

function newId(list: SavedChain[]): string {
  let i = list.length + 1;
  while (list.some((c) => c.id === `c${i}`)) i++;
  return `c${i}`;
}

/** Enregistre (ou remplace, si le nom existe déjà). Renvoie la nouvelle liste. */
export function saveChain(list: SavedChain[], name: string, project: PatchProject, now: Date = new Date()): SavedChain[] {
  const clean = name.trim();
  if (!clean) throw new Error('Donnez un nom à la chaîne.');
  const entry: SavedChain = { id: '', name: clean, savedAt: now.toISOString(), project: clone(project) };
  const i = list.findIndex((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (i >= 0) { entry.id = list[i]?.id ?? newId(list); return list.map((c, k) => (k === i ? entry : c)); }
  entry.id = newId(list);
  return [...list, entry];
}

export function removeChain(list: SavedChain[], id: string): SavedChain[] {
  return list.filter((c) => c.id !== id);
}

export function duplicateChain(list: SavedChain[], id: string, now: Date = new Date()): SavedChain[] {
  const src = list.find((c) => c.id === id);
  if (!src) return list;
  let name = `${src.name} (copie)`; let k = 2;
  while (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) name = `${src.name} (copie ${k++})`;
  return [...list, { id: newId(list), name, savedAt: now.toISOString(), project: clone(src.project) }];
}

export function loadChain(list: SavedChain[], id: string): PatchProject | null {
  const c = list.find((x) => x.id === id);
  return c ? clone(c.project) : null;
}

export function serializeLibrary(list: SavedChain[]): string {
  return JSON.stringify({ format: 'carla-wiring-chains', version: 1, chains: list }, null, 2);
}

/** Fusionne un fichier de chaînes ; les noms déjà présents reçoivent « (importée) ». */
export function importChains(list: SavedChain[], text: string): { list: SavedChain[]; added: number } {
  const incoming = parseLibrary(JSON.parse(text) as unknown);
  let out = list; let added = 0;
  for (const c of incoming) {
    let name = c.name; let k = 2;
    while (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${c.name} (importée${k > 2 ? ' ' + (k - 1) : ''})`, k++;
    out = [...out, { ...c, id: newId(out), name }]; added++;
  }
  return { list: out, added };
}
