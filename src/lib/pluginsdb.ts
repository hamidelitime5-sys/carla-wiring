// src/lib/pluginsdb.ts : fusion de la base de plugins (un scan ne doit pas effacer ce qui existe déjà).
import type { DbPlugin } from './carxp';

export const dbKey = (p: { path: string; name: string }): string => `${p.path}|${p.name}`;

/**
 * Ajoute les plugins trouvés à la base existante. Un plugin déjà connu (même fichier et même nom) est mis à jour avec les
 * données du dernier scan ; les autres plugins de la base sont conservés.
 */
export function mergePlugins(existing: DbPlugin[], found: DbPlugin[]): { merged: DbPlugin[]; added: number; updated: number } {
  const map = new Map(existing.map((p) => [dbKey(p), p]));
  let added = 0, updated = 0;
  for (const p of found) {
    if (map.has(dbKey(p))) updated++; else added++;
    map.set(dbKey(p), p);
  }
  return { merged: [...map.values()], added, updated };
}
