// src/lib/api.ts : passerelle vers les commandes Rust (Tauri). Aucune donnée fictive :
// hors de l'application Tauri, chaque appel échoue avec un message clair.
import type { DbPlugin } from './carxp';

export interface ScanError { type: string; path: string; reason: string }
export interface ScanReport { plugins: DbPlugin[]; errors: ScanError[]; totalFiles: number }
export interface ScanProgress { done: number; total: number; current: string }

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function message(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Cette fonction n'existe que dans l'application Carla Wiring (Tauri), pas dans un simple navigateur.");
  const { invoke } = await import('@tauri-apps/api/core');
  try { return await invoke<T>(cmd, args); } catch (e) { throw new Error(message(e)); }
}

export const findDiscovery = () => call<string | null>('find_discovery');
/** Pour les tests : remplace les boîtes de dialogue et les accès fichiers. */
export interface TestHooks {
  pickOpen: (name: string, extensions: string[]) => Promise<string | null>;
  pickSave: (defaultName: string, name: string, extensions: string[]) => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string) => Promise<void>;
  checkPaths: (paths: string[]) => Promise<boolean[]>;
  discoverPresetDirs: (hints: string[], extraRoots: string[]) => Promise<DiscoveredDir[]>;
  analyseSubfolders: (folder: string) => Promise<SubfolderInfo[]>;
  scanExtensions: (folder: string) => Promise<ExtCount[]>;
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  scanPlugins: (discovery: string, vst3: string[], vst2: string[], onProgress: (p: ScanProgress) => void) => Promise<ScanReport>;
  scanPresets: (roots: string[], extensions: string[], onProgress: (p: PresetProgress) => void) => Promise<PresetScanReport>;
}
let hooks: Partial<TestHooks> = {};
export function setTestHooks(h: Partial<TestHooks>): void { hooks = h; }

export const readTextFile = (path: string): Promise<string> => (hooks.readTextFile ? hooks.readTextFile(path) : call<string>('read_text_file', { path }));
/** Lit un fichier binaire autorisé (.t3kpreset) : renvoie ses octets. */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  if (hooks.readBinaryFile) return hooks.readBinaryFile(path);
  const b64 = await call<string>('read_binary_file', { path });
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const writeTextFile = (path: string, content: string): Promise<void> => (hooks.writeTextFile ? hooks.writeTextFile(path, content) : call<void>('write_text_file', { path, content }));
/** Pour chaque chemin : le fichier existe-t-il encore ? */
export const checkPaths = (paths: string[]): Promise<boolean[]> => (hooks.checkPaths ? hooks.checkPaths(paths) : call<boolean[]>('check_paths', { paths }));
export const launchCarla = (exe: string, project?: string) => call<number>('launch_carla', { exe, project: project ?? null });

export async function scanPlugins(
  discovery: string, vst3: string[], vst2: string[], onProgress: (p: ScanProgress) => void,
): Promise<ScanReport> {
  if (hooks.scanPlugins) return hooks.scanPlugins(discovery, vst3, vst2, onProgress);
  if (!isTauri()) throw new Error("Cette fonction n'existe que dans l'application Carla Wiring (Tauri), pas dans un simple navigateur.");
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<ScanProgress>('scan-progress', (e) => onProgress(e.payload));
  try {
    return await call<ScanReport>('scan_plugins', { req: { discovery, vst3, vst2, timeoutSecs: 60 } });
  } finally {
    unlisten();
  }
}

export async function pickOpen(name: string, extensions: string[]): Promise<string | null> {
  if (hooks.pickOpen) return hooks.pickOpen(name, extensions);
  if (!isTauri()) throw new Error("Les boîtes de dialogue n'existent que dans l'application Tauri.");
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
  return typeof r === 'string' ? r : null;
}

export async function pickFolder(): Promise<string | null> {
  if (hooks.pickFolder) return hooks.pickFolder();
  if (!isTauri()) throw new Error("Les boîtes de dialogue n'existent que dans l'application Tauri.");
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ multiple: false, directory: true });
  return typeof r === 'string' ? r : null;
}

export async function pickSave(defaultName: string, name: string, extensions: string[]): Promise<string | null> {
  if (hooks.pickSave) return hooks.pickSave(defaultName, name, extensions);
  if (!isTauri()) throw new Error("Les boîtes de dialogue n'existent que dans l'application Tauri.");
  const { save } = await import('@tauri-apps/plugin-dialog');
  return await save({ defaultPath: defaultName, filters: [{ name, extensions }] });
}

// ---------------------------------------------------------------------------------------------
// Assistant IA (l'appel part du moteur Rust : la clé n'est jamais écrite dans un journal)

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama';
export interface AiConfig { provider: AiProvider; model: string; apiKey: string; baseUrl?: string; numCtx?: number }
export interface AiMessage { role: 'user' | 'assistant'; content: string }
export type AiTransport = (cfg: AiConfig, system: string, messages: AiMessage[]) => Promise<string>;

let transport: AiTransport | null = null;
/** Pour les tests : remplace l'appel réel à l'IA. */
export function setAiTransport(t: AiTransport | null): void { transport = t; }

/** `onWait(secondes)` est appelé quand la limite de requêtes est atteinte : le moteur attend puis réessaie tout seul. */
export async function aiAsk(cfg: AiConfig, system: string, messages: AiMessage[], onWait?: (seconds: number) => void): Promise<string> {
  if (transport) return transport(cfg, system, messages);
  let unlisten: (() => void) | null = null;
  if (onWait && isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<number>('ai-wait', (e) => onWait(e.payload));
  }
  try {
    return await call<string>('ai_ask', { req: { provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, system, messages, baseUrl: cfg.baseUrl, numCtx: cfg.numCtx } });
  } finally {
    unlisten?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Presets (scan du disque) et dossier de données

export interface PresetFile { path: string; name: string; ext: string; kind: string; vstId: number | null; classId: string | null; hints: string[]; size: number }
export interface PresetScanReport { entries: PresetFile[]; visitedDirs: number; truncated: boolean; cancelled: boolean; unreadable: number }
export interface PresetProgress { dirs: number; found: number; current: string }
export interface ExtCount { ext: string; count: number; example: string }

export const dataDir = () => call<string>('data_dir');
export const cancelPresetScan = () => call<void>('cancel_preset_scan');
export const scanExtensions = (folder: string): Promise<ExtCount[]> => (hooks.scanExtensions ? hooks.scanExtensions(folder) : call<ExtCount[]>('scan_extensions', { folder }));
export interface SubfolderInfo { name: string; path: string; files: number; exts: ExtCount[] }
export const analyseSubfolders = (folder: string): Promise<SubfolderInfo[]> =>
  (hooks.analyseSubfolders ? hooks.analyseSubfolders(folder) : call<SubfolderInfo[]>('analyse_subfolders', { folder }));
export interface DiscoveredDir { path: string; name: string; files: number; exts: ExtCount[] }
export const discoverPresetDirs = (hints: string[], extraRoots: string[]): Promise<DiscoveredDir[]> =>
  (hooks.discoverPresetDirs ? hooks.discoverPresetDirs(hints, extraRoots) : call<DiscoveredDir[]>('discover_preset_dirs', { hints, extraRoots }));

export async function scanPresets(
  roots: string[], extensions: string[], onProgress: (p: PresetProgress) => void, maxEntries?: number,
): Promise<PresetScanReport> {
  if (hooks.scanPresets) return hooks.scanPresets(roots, extensions, onProgress);
  if (!isTauri()) throw new Error("Cette fonction n'existe que dans l'application Carla Wiring (Tauri), pas dans un simple navigateur.");
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<PresetProgress>('preset-progress', (e) => onProgress(e.payload));
  try {
    return await call<PresetScanReport>('scan_presets', { req: { roots, extensions, maxEntries } });
  } finally {
    unlisten();
  }
}
