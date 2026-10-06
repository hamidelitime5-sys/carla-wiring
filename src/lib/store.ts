// src/lib/store.ts : enregistrement des données volumineuses (index des presets, sons capturés).
// Dans l'application : fichiers JSON dans le dossier de données (pas de limite de taille du navigateur).
// Hors application (tests, navigateur) : stockage du navigateur.
import * as api from './api';

const PREFIX = 'carlaWiring.store.';

async function pathOf(name: string): Promise<string> {
  const d = (await api.dataDir()).replace(/[\\/]+$/, '');
  return `${d}${d.includes('\\') ? '\\' : '/'}${name}.json`;
}

export async function storeRead<T>(name: string): Promise<T | null> {
  try {
    if (api.isTauri()) return JSON.parse(await api.readTextFile(await pathOf(name))) as T;
    const raw = localStorage.getItem(PREFIX + name);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // fichier absent ou illisible : on repart de zéro
  }
}

export async function storeWrite(name: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data);
  if (api.isTauri()) { await api.writeTextFile(await pathOf(name), text); return; }
  localStorage.setItem(PREFIX + name, text);
}
