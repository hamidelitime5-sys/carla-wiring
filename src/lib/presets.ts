// src/lib/presets.ts : presets de plugins (fichiers du disque + « sons capturés » depuis des projets Carla).
//
// Deux sortes de presets :
//  - FICHIER (.fxp, .vstpreset…) : retrouvé sur le disque, associé à un plugin, PROPOSÉ par l'assistant ; à charger
//    dans le plugin (le format d'état interne de Carla n'est pas celui de ces fichiers, on ne le fabrique pas).
//  - SON CAPTURÉ : l'état d'un plugin lu dans un projet .carxp enregistré par Carla ; réinjecté tel quel dans le
//    projet exporté, donc appliqué automatiquement (c'est le format de Carla lui-même).
import { importCarxp, type DbPlugin, type PatchNode, type PatchProject, type PresetRef } from './carxp';
import { describeState } from './statenames';
import { t3kPresetToChunk } from './t3k';
import { buildBlueCatState, checkVc2State } from './vst3state';

export interface PresetEntry {
  path: string; name: string; ext: string; kind: string;
  vstId: number | null; classId: string | null; hints: string[]; size: number;
}

export interface PresetIndex {
  version: 1; scannedAt: string; roots: string[]; extensions: string[]; truncated: boolean; entries: PresetEntry[];
}

export interface StatePreset {
  id: string; name: string; pluginKey: string; pluginName: string; chunk: string; source: string; createdAt: string;
  collection?: string; // dossier du preset d'origine (ex. « Guitar - Clean + FX »), lu dans l'état quand le format le permet
  program?: { index: number; name: string }; // programme actif noté par Carla (ex. Melda), rejoué avec l'état
  keywords?: string[]; // mots utiles à la recherche (tags, fabricants) lus dans l'état ; non affichés
}

export interface PresetCandidate { kind: 'file' | 'state'; name: string; path?: string; stateId?: string; chunk?: string; collection?: string; program?: { index: number; name: string } }

export const pluginKey = (p: { path: string; name: string }): string => `${p.path}|${p.name}`;

const SUFFIXES = ['vst3', 'vst', 'x64', 'data', 'presets', 'preset', 'banks', 'bank'];
const VENDOR_PREFIXES = ['meldaproduction', 'bluecats', 'bluecat', 'bc']; // « BC Axiom » = « Blue Cat's Axiom » ; « MeldaProduction MXXX » = « MXXX »

/** Forme comparable d'un nom de plugin ou de dossier : minuscules, sans ponctuation, sans « VST3 », « data »… */
export function norm(s: string): string {
  // « BC Dynamics 4 VST3(Stereo) data » et « Blue Cat's Dynamics 4(Stereo) » : les mentions de format (VST, VST3, x64…) sont retirées où qu'elles soient
  let n = s.replace(/\b(vst3|vst|x64|x86)\b/gi, ' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  for (let again = true; again;) {
    again = false;
    for (const suf of SUFFIXES) if (n.length > suf.length + 2 && n.endsWith(suf)) { n = n.slice(0, -suf.length); again = true; }
  }
  for (const pre of VENDOR_PREFIXES) if (n.startsWith(pre) && n.length - pre.length >= 3) { n = n.slice(pre.length); break; }
  return n;
}

export interface Matcher { match(e: PresetEntry): DbPlugin | undefined; matchAt(e: PresetEntry): { plugin: DbPlugin; depth: number } | undefined }

// Noms de dossiers sans signification propre (ils ne désignent pas une famille de presets)
const GENERIC = new Set(['', 'presets', 'preset', 'factory', 'user', 'library', 'content', 'data', 'banks', 'bank', 'sounds', 'programs', 'patches', 'vst3', 'vst', 'x64', 'fxp', 'fxb']);

/** Famille d'un preset : le dossier le plus proche, sous celui du plugin, qui a un nom parlant (ex. Content\\Reflektor\\Presets\\x → « Reflektor »). */
export function collectionOf(e: PresetEntry, depth: number): string | undefined {
  const below = depth >= 0 ? e.hints.slice(0, depth) : e.hints.slice(0, 1);
  return below.find((h) => !GENERIC.has(norm(h)));
}

export function makeMatcher(db: DbPlugin[]): Matcher {
  const byId = new Map<number, DbPlugin>();
  const byName = new Map<string, DbPlugin>();
  for (const p of db) {
    if (p.uniqueId !== null && !byId.has(p.uniqueId)) byId.set(p.uniqueId, p);
    const n = norm(p.name);
    if (n && !byName.has(n)) byName.set(n, p);
  }
  const memo = new Map<string, DbPlugin | undefined>();
  const byHint = (hint: string): DbPlugin | undefined => {
    if (memo.has(hint)) return memo.get(hint);
    const h = norm(hint);
    let hit: DbPlugin | undefined = h ? byName.get(h) : undefined;
    if (!hit && h.length >= 5) {
      // le dossier contient le nom du plugin, ou le nom du plugin contient celui du dossier s'il en couvre au moins la moitié (évite « player » ↔ « SynthMaster 2 Player »)
      for (const [n, p] of byName) if (n.length >= 5 && (h.includes(n) || (n.includes(h) && h.length * 2 >= n.length))) { hit = p; break; }
    }
    memo.set(hint, hit);
    return hit;
  };
  const matchAt = (e: PresetEntry): { plugin: DbPlugin; depth: number } | undefined => {
    if (e.vstId !== null) { const hit = byId.get(e.vstId); if (hit) return { plugin: hit, depth: -1 }; }
    for (let i = 0; i < e.hints.length; i++) { const hit = byHint(e.hints[i] ?? ''); if (hit) return { plugin: hit, depth: i }; }
    return undefined;
  };
  return { match: (e) => matchAt(e)?.plugin, matchAt };
}

export interface PresetBook {
  total: number; assigned: number; unassigned: PresetEntry[]; states: number;
  /** `minScore` : n'envoie que les presets dont la pertinence pour la demande atteint ce seuil (3 = au moins un mot en commun). */
  forPlugin(p: DbPlugin, request: string, limit: number, minScore?: number): PresetCandidate[];
  countFor(p: DbPlugin): number;
}

// Les bibliothèques de presets sont souvent en anglais : « saturé » doit retrouver « crunch », « fuzz », « drive »…
const SYNONYMS: Array<[string, string[]]> = [
  ['sature', ['saturated', 'drive', 'crunch', 'distortion', 'fuzz', 'overdrive', 'gain', 'heavy', 'dirty']], ['distors', ['distortion', 'fuzz', 'crunch', 'drive', 'overdrive']],
  ['crunch', ['crunch', 'drive']], ['lead', ['lead', 'solo']], ['solo', ['solo', 'lead']], ['clair', ['clean', 'clear', 'crystal']], ['propre', ['clean']],
  ['enceinte', ['cabinet', 'cab', 'speaker', '4x12', '2x12', '1x12']], ['baffle', ['cabinet', 'cab', 'speaker']], ['cabinet', ['cabinet', 'cab']], ['micro', ['mic', 'microphone']], ['ampli', ['amp']], ['ressort', ['spring']], ['bande', ['tape']], ['metronom', ['metronome']],
  ['basse', ['bass']], ['chaud', ['warm']], ['doux', ['soft', 'smooth', 'mellow', 'gentle']], ['gras', ['fat', 'thick']], ['brillant', ['bright']], ['sombre', ['dark']],
  ['large', ['wide']], ['ambian', ['ambient']], ['vintage', ['vintage', 'retro']], ['modern', ['modern']], ['acoustique', ['acoustic']], ['orgue', ['organ']],
  ['nappe', ['pad', 'strings']], ['cordes', ['strings']], ['cuivre', ['brass']], ['voix', ['vocal', 'voice', 'vox']], ['batterie', ['drum', 'drums']],
  ['reverb', ['reverb', 'room', 'hall', 'plate']], ['echo', ['delay', 'echo']], ['delay', ['delay', 'echo']], ['compress', ['comp', 'compressor']],
  ['jazz', ['jazz']], ['blues', ['blues']], ['funk', ['funk']], ['rock', ['rock']], ['metal', ['metal']], ['country', ['country']], ['pop', ['pop']],
];
function expand(ws: string[]): string[] {
  const out = new Set<string>();
  for (const w of ws) for (const [k, en] of SYNONYMS) if (w.startsWith(k)) for (const e of en) out.add(e);
  return [...out];
}

const words = (request: string): string[] => request.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4);

/** Associe les presets du disque aux plugins de la base et prépare la recherche par pertinence pour une demande. */
export function makeBook(index: PresetIndex | null, states: StatePreset[], db: DbPlugin[]): PresetBook {
  const matcher = makeMatcher(db);
  const byKey = new Map<string, PresetEntry[]>();
  const unassigned: PresetEntry[] = [];
  const collections = new Map<PresetEntry, string | undefined>();
  let assigned = 0;
  for (const e of index?.entries ?? []) {
    const m = matcher.matchAt(e);
    if (!m) { unassigned.push(e); continue; }
    const hit = m.plugin;
    collections.set(e, collectionOf(e, m.depth));
    const k = pluginKey(hit);
    const list = byKey.get(k) ?? [];
    list.push(e); byKey.set(k, list); assigned++;
  }
  const stateByKey = new Map<string, StatePreset[]>();

  for (const s of states) stateByKey.set(s.pluginKey, [...(stateByKey.get(s.pluginKey) ?? []), s]);
  return {
    total: index?.entries.length ?? 0, assigned, unassigned, states: states.length,
    countFor: (p) => (byKey.get(pluginKey(p))?.length ?? 0) + (stateByKey.get(pluginKey(p))?.length ?? 0),
    forPlugin(p, request, limit, minScore = Number.NEGATIVE_INFINITY) {
      const w = words(request);
      const w2 = expand(w).filter((x) => !w.includes(x));
      const score = (name: string, hints: string[], bonus: number, collection?: string): number => {
        const n = norm(name);
        const nn = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        let s = bonus;
        for (const x of w) { if (nn.includes(x) || n.includes(x)) s += 3; if (hints.some((h) => h.toLowerCase().includes(x))) s += 1; }
        for (const x of w2) if (nn.includes(x)) s += 2;
        if (collection) { const cc = collection.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); for (const x of [...w, ...w2]) if (cc.includes(x)) s += 2; }
        return s;
      };
      const keywordScore = (kws?: string[]): number => (kws ? w.reduce((n, x) => n + (kws.some((k) => k.includes(x)) ? 2 : 0), 0) : 0);
      const cands: Array<PresetCandidate & { s: number }> = [];
      for (const st of stateByKey.get(pluginKey(p)) ?? []) cands.push({ kind: 'state', name: st.name, stateId: st.id, chunk: st.chunk, ...(st.collection ? { collection: st.collection } : {}), ...(st.program ? { program: st.program } : {}), s: score(st.name, [], 2, st.collection) + keywordScore(st.keywords) });
      for (const e of byKey.get(pluginKey(p)) ?? []) { const col = collections.get(e); cands.push({ kind: 'file', name: e.kind === 'fxb' ? `Banque ${e.name}` : e.name, path: e.path, ...(col ? { collection: col } : {}), s: score(e.name, e.hints, 0, col) }); }
      return cands.filter((c) => c.s >= minScore).sort((a, b) => b.s - a.s || a.name.localeCompare(b.name)).slice(0, limit).map(({ s: _s, ...c }) => c);
    },
  };
}

/** Un preset choisi pour un plugin du patchbay. Un « son capturé » remplace l'état du plugin ; un fichier est seulement mémorisé. */
export function applyPreset(node: PatchNode, cand: PresetCandidate): void {
  const ref: PresetRef = { kind: cand.kind, name: cand.name, path: cand.path, stateId: cand.stateId, ...(cand.collection ? { collection: cand.collection } : {}) };
  node.preset = ref;
  if (cand.kind === 'state' && cand.chunk) {
    node.chunk = cand.chunk;
    if (cand.program) node.program = { ...cand.program }; else delete node.program;
    delete node.raw; // le bloc d'origine contiendrait l'ancien état : on régénère le bloc avec le nouvel état
  }
}

export function clearPreset(node: PatchNode): void { delete node.preset; }

/** Lit l'état de chaque plugin d'un projet Carla enregistré (balise <Chunk>) : « sons capturés » réutilisables. */
export function captureStates(xml: string, sourceName: string, db: DbPlugin[], now: Date = new Date()): StatePreset[] {
  return captureReport(xml, sourceName, db, now).states;
}

/** Comme `captureStates`, mais signale aussi les états refusés (tronqués ou abîmés) avec la raison. */
export function captureReport(xml: string, sourceName: string, db: DbPlugin[], now: Date = new Date()): { states: StatePreset[]; rejected: Array<{ plugin: string; problem: string }> } {
  const imp = importCarxp(xml);
  const rejected: Array<{ plugin: string; problem: string }> = [];
  const stamp = now.getTime().toString(36);
  const out: StatePreset[] = [];
  const used = new Map<string, number>();
  imp.plugins.forEach((p, i) => {
    if (!p.chunk) return;
    const chk = checkVc2State(p.chunk);
    if (!chk.ok) { rejected.push({ plugin: p.name, problem: chk.problem ?? 'état abîmé' }); return; }
    const hit = db.find((d) => (d.path && d.path.replace(/\\/g, '/').toLowerCase() === p.binary.replace(/\\/g, '/').toLowerCase()) || (d.name === p.name && d.type === p.type));
    const key = hit ? pluginKey(hit) : pluginKey({ path: p.binary, name: p.name });
    const n = (used.get(key) ?? 0) + 1; used.set(key, n);
    // l'état contient (selon le plugin) le nom du preset réellement choisi dans Carla et son dossier d'origine
    const info = describeState(p.chunk);
    const folder = info.collection;
    const name = info.name ? `${info.name} (${sourceName})` : `${p.name} – ${sourceName}`;
    out.push({ id: `st-${stamp}-${i}`, name: `${name}${n > 1 ? ` (${n})` : ''}`, pluginKey: key, pluginName: p.name, chunk: p.chunk, source: sourceName, createdAt: now.toISOString(), ...(folder ? { collection: folder } : {}), ...(info.keywords?.length ? { keywords: info.keywords } : {}), ...(p.programIndex !== undefined ? { program: { index: p.programIndex, name: p.programName ?? '' } } : {}) });
  });
  return { states: out, rejected };
}

export function normalizeIndex(x: unknown): PresetIndex | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.entries)) return null;
  const entries = o.entries.filter((e): e is PresetEntry => typeof e === 'object' && e !== null && typeof (e as PresetEntry).path === 'string' && typeof (e as PresetEntry).name === 'string');
  return { version: 1, scannedAt: typeof o.scannedAt === 'string' ? o.scannedAt : '', roots: Array.isArray(o.roots) ? (o.roots as string[]) : [], extensions: Array.isArray(o.extensions) ? (o.extensions as string[]) : [], truncated: o.truncated === true, entries };
}

export function normalizeStates(x: unknown): StatePreset[] {
  const arr = Array.isArray(x) ? x : (typeof x === 'object' && x !== null ? (x as { states?: unknown }).states : undefined);
  if (!Array.isArray(arr)) return [];
  return arr.filter((s): s is StatePreset => typeof s === 'object' && s !== null && typeof (s as StatePreset).id === 'string' && typeof (s as StatePreset).chunk === 'string' && typeof (s as StatePreset).pluginKey === 'string');
}

// ---------------------------------------------------------------------------------------------
// Découverte automatique : quels dossiers et quels formats de presets pour mes plugins ?

export interface ExtInfo { ext: string; count: number; example: string }
export interface FoundDir { path: string; name: string; files: number; exts: ExtInfo[] }

/** Indices envoyés au moteur : noms (et éditeurs) simplifiés de vos plugins. */
export function hintsFromDb(db: DbPlugin[], max = 1500): string[] {
  const out = new Set<string>();
  for (const p of db) {
    for (const v of [p.name, p.maker]) { const n = norm(v); if (n.length >= 4) out.add(n); }
    if (out.size >= max) break;
  }
  return [...out];
}

/** Plugins de la base dont le nom correspond à celui d'un dossier. */
export function pluginsForDir(dirName: string, db: DbPlugin[]): DbPlugin[] {
  const d = norm(dirName);
  if (d.length < 4) return [];
  return db.filter((p) => { const n = norm(p.name); return n === d || (n.length >= 5 && d.length >= 5 && (d.includes(n) || (n.includes(d) && d.length * 2 >= n.length))); });
}

// Extensions qui ne sont presque jamais des presets (positions de fenêtre, images, sons, journaux…)
const NOISE = new Set(['qmlc', 'qml', 'jsc', 'winstate', 'ini', 'log', 'tmp', 'cache', 'db', 'dll', 'exe', 'lnk', 'bak', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'wav', 'mp3', 'flac', 'ogg', 'aif', 'aiff', 'pdf', 'html', 'htm', 'css', 'js', 'pak', 'lic', 'license', '(sans extension)']);
// formats de presets connus : .ngrr (Guitar Rig, vu chez vous), .nksf (Native Instruments), .h2p (u-he), .vital (Vital), .ffp (FabFilter)
const LIKELY = /preset|^fxp$|^fxb$|^vstpreset$|^bank$|patch|program|^active$|^ngrr$|^nksf$|^h2p$|^vital$|^ffp$/;

/** Range les extensions d'un dossier : probables presets, bruit, et « à vérifier » (que l'utilisateur décide d'ajouter ou non). */
export function classifyExts(exts: ExtInfo[]): { likely: ExtInfo[]; noise: ExtInfo[]; other: ExtInfo[] } {
  const r = { likely: [] as ExtInfo[], noise: [] as ExtInfo[], other: [] as ExtInfo[] };
  for (const e of exts) {
    const x = e.ext.toLowerCase();
    if (NOISE.has(x)) r.noise.push(e); else if (LIKELY.test(x)) r.likely.push(e); else r.other.push(e);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Fichiers .preset de Blue Cat's → état du plugin, écrit dans le .carxp

/** Plugin Blue Cat's au format VST3 : le seul dont l'état (VC2! + document <Preset>) est connu et vérifié. */
export function isBlueCatVst3(p: DbPlugin | undefined): boolean {
  return !!p && p.type === 'VST3' && /blue\s*cat|[\\/ ]BC /i.test(`${p.name} ${p.path}`);
}

/** Plugin TONE3000 (VST3) : le seul dont les fichiers .t3kpreset sont convertis (format vérifié). */
export function isTone3000(p: DbPlugin | undefined): boolean {
  return !!p && p.type === 'VST3' && norm(p.name) === 'tone3000';
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Convertit le contenu d'un fichier .preset de Blue Cat's en <Chunk> prêt à être écrit dans le .carxp.
 * L'état enregistré par Carla EST ce document <Preset> (nom, chemin, réglages) : on l'enveloppe de la même façon.
 */
export function presetFileToChunk(plugin: DbPlugin | undefined, fileText: string, filePath: string): { chunk: string; name: string } | { error: string } {
  if (!isBlueCatVst3(plugin)) return { error: 'ce plugin n\'est pas un plugin Blue Cat\'s VST3 (seul format dont l\'état est connu)' };
  let text = fileText.replace(/^\uFEFF/, '').replace(/\0+$/, '').trim();
  const body = /<Preset[\s>]/.exec(text);
  if (!body || !/^(<\?xml[^>]*\?>\s*)?<Preset[\s>]/.test(text) || !text.endsWith('</Preset>')) return { error: 'le fichier n\'est pas un document <Preset> XML complet (format différent de celui attendu)' };
  text = `${XML_DECL}${text.slice(body.index)}`;
  const stem = (filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')) || 'Preset';
  if (!/<Preset\b[^>]*\bprogName="/.test(text)) text = text.replace(/<Preset\b/, `<Preset progName="${stem.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  const name = (/<Preset\b[^>]*\bprogName="([^"]*)"/.exec(text)?.[1] ?? stem).replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return { chunk: buildBlueCatState(text), name };
}

/**
 * Pour chaque plugin Blue Cat's dont le preset choisi est un fichier .preset, lit le fichier et écrit l'état dans le projet.
 * Ne lève jamais d'exception : ce qui ne peut pas être appliqué est listé dans `skipped` avec la raison.
 */
export async function injectFilePresets(
  project: PatchProject, read: (path: string) => Promise<string>, readBinary?: (path: string) => Promise<Uint8Array>,
): Promise<{ applied: number; skipped: string[] }> {
  let applied = 0;
  const skipped: string[] = [];
  for (const n of project.nodes) {
    const ref = n.preset;
    if (!ref || ref.kind !== 'file' || !ref.path || ref.applied) continue;
    if (/\.t3kpreset$/i.test(ref.path)) {
      // TONE3000 : fichier binaire (chaîne + modèles embarqués) converti en état de plugin
      if (!isTone3000(n.plugin)) { skipped.push(`« ${n.name} » : un fichier .t3kpreset ne s'applique qu'au plugin TONE3000`); continue; }
      if (!readBinary) { skipped.push(`« ${n.name} » : lecture de fichier binaire indisponible ici`); continue; }
      try {
        const r = t3kPresetToChunk(await readBinary(ref.path));
        n.chunk = r.chunk; delete n.raw; delete n.program; ref.applied = true; applied++;
      } catch (e) {
        skipped.push(`« ${n.name} » : ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    if (!/\.preset$/i.test(ref.path)) continue;
    try {
      const r = presetFileToChunk(n.plugin, await read(ref.path), ref.path);
      if ('error' in r) { skipped.push(`« ${n.name} » : ${r.error}`); continue; }
      n.chunk = r.chunk; delete n.raw; ref.applied = true; applied++;
    } catch (e) {
      skipped.push(`« ${n.name} » : fichier illisible (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { applied, skipped };
}
