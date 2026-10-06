// src/main.ts : interface de Carla Wiring (outil de PRÉPARATION du patchbay de Carla).
//   Assistant : vous décrivez ce que vous voulez jouer, l'IA construit la chaîne avec VOS plugins.
//   Patchbay  : vous voyez et corrigez la chaîne à la souris, puis vous exportez un .carxp pour Carla.
//   Plugins   : scan de votre bibliothèque (la base sur laquelle s'appuie l'assistant).
// Aucune donnée fictive : tout vient du scan, de l'IA (vérifiée) ou de vos gestes.
import * as api from './lib/api';
import { exportCarxp, importCarxp, validateProject, type DbPlugin, type HardwareProfile, type PatchProject } from './lib/carxp';
import { generateChain, type GenerateOutcome } from './lib/chain';
import { History } from './lib/history';
import { projectFromCarxp } from './lib/importer';
import { chainSheet } from './lib/sheet';
import { duplicateChain, importChains, loadChain, parseLibrary, removeChain, saveChain, serializeLibrary, type SavedChain } from './lib/library';
import { addPlugin, alignNodes, autoLayout, colorByRole, COLORS, distributeNodes, emptyProject, ensureHardware, fanOutMono, HW_NAMES, replacePlugin, setColor, snapNodes, type AlignMode, type HwKind } from './lib/editor';
import { applyPreset, captureReport, classifyExts, clearPreset, hintsFromDb, injectFilePresets, isBlueCatVst3, isTone3000, makeBook, normalizeIndex, normalizeStates, pluginsForDir, type PresetBook, type PresetIndex, type StatePreset } from './lib/presets';
import { storeRead, storeWrite } from './lib/store';
import { mergePlugins } from './lib/pluginsdb';
import { roleCounts, rolesOf, ROLE_LABEL, ROLES, type Role } from './lib/roles';
import { buildFromRecipe, defaultGuitarInput, RECIPES, stepLabel, suggestRecipe } from './lib/recipes';
import { addProposedScenes, applyScene, generateScenes, planSceneFiles, removeScene, saveScene, validateScene } from './lib/scenes';
import { mountPatchbay, type PatchbayView } from './lib/patchbay';

// ---------------------------------------------------------------------------------------------
// Réglages et état (mémorisés dans l'application)

interface Settings {
  provider: api.AiProvider; backup: api.AiProvider | ''; models: Record<api.AiProvider, string>; apiKeys: Record<api.AiProvider, string>; request: string;
  ollamaUrl: string; ollamaCtx: number; ollamaMaxPlugins: number;
  centerForCarla: boolean; snapGrid: boolean; usePresets: boolean; autoApplyBluecat: boolean;
  mergeScan: boolean; recipe: string; guitarInput: string; roleOverrides: Record<string, Role | ''>;
  presetMode: 'dossiers' | 'disque'; presetRoots: string; diskRoot: string; presetExts: string;
  audioIn: string; audioOut: string; midiIn: string;
  carlaExe: string; discovery: string; vst3: string; vst2: string;
  modifyCurrent: boolean;
}

const DEFAULT_MODELS: Record<api.AiProvider, string> = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', gemini: 'gemini-3.8-flash', ollama: 'qwen2.5:7b' };
const DEFAULTS: Settings = {
  provider: 'anthropic', backup: '', models: { ...DEFAULT_MODELS }, apiKeys: { anthropic: '', openai: '', gemini: '', ollama: '' }, request: '',
  ollamaUrl: 'http://localhost:11434', ollamaCtx: 16384, ollamaMaxPlugins: 100,
  centerForCarla: true, snapGrid: false, usePresets: true, autoApplyBluecat: false,
  mergeScan: true, recipe: 'jazz-benson', guitarInput: '', roleOverrides: {},
  presetMode: 'dossiers', presetRoots: 'C:\\Program Files\\Common Files\\VST3\nC:\\ProgramData\\VST3 Presets', diskRoot: 'C:\\', presetExts: 'fxp,fxb,vstpreset,preset',
  audioIn: 'capture_1\ncapture_2', audioOut: 'playback_1\nplayback_2', midiIn: 'Capture 1',
  carlaExe: '', discovery: '', modifyCurrent: false,
  vst3: 'C:\\Program Files\\Common Files\\VST3', vst2: 'C:\\Program Files\\VstPlugins\nC:\\Program Files\\Steinberg\\VstPlugins',
};
type StrKey = 'presetRoots' | 'diskRoot' | 'presetExts' | 'request' | 'audioIn' | 'audioOut' | 'midiIn' | 'carlaExe' | 'discovery' | 'vst3' | 'vst2';

const KEY_SETTINGS = 'carlaWiring.settings', KEY_DB = 'carlaWiring.db', KEY_PROJECT = 'carlaWiring.project', KEY_LIBRARY = 'carlaWiring.library';

function loadSettings(): Settings {
  const fresh = (): Settings => ({ ...DEFAULTS, models: { ...DEFAULT_MODELS }, apiKeys: { ...DEFAULTS.apiKeys } });
  try {
    const raw = localStorage.getItem(KEY_SETTINGS); if (!raw) return fresh();
    const parsed = JSON.parse(raw) as Partial<Settings> & { apiKey?: string; model?: string };
    const s: Settings = { ...fresh(), ...parsed, models: { ...DEFAULT_MODELS, ...(parsed.models ?? {}) }, apiKeys: { ...DEFAULTS.apiKeys, ...(parsed.apiKeys ?? {}) } };
    // ancienne version : une seule clé / un seul modèle → ceux du fournisseur courant
    if (typeof parsed.apiKey === 'string' && parsed.apiKey && !s.apiKeys[s.provider]) s.apiKeys[s.provider] = parsed.apiKey;
    if (typeof parsed.model === 'string' && parsed.model) s.models[s.provider] = parsed.model;
    delete (s as unknown as Record<string, unknown>).apiKey; delete (s as unknown as Record<string, unknown>).model;
    // ancien nom par défaut devenu indisponible chez Google (erreur 404) : remplacé par le modèle actuel
    if (s.models.gemini === 'gemini-2.5-flash') s.models.gemini = DEFAULT_MODELS.gemini;
    return s;
  } catch { return fresh(); }
}
function normalizePlugin(x: unknown): DbPlugin | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (!s(o.name).trim()) return null;
  return {
    type: s(o.type) || 'VST2', name: s(o.name), label: s(o.label), maker: s(o.maker), path: s(o.path),
    uniqueId: typeof o.uniqueId === 'number' ? o.uniqueId : null, category: s(o.category), isSynth: o.isSynth === true,
    audioIns: n(o.audioIns), audioOuts: n(o.audioOuts), midiIns: n(o.midiIns), midiOuts: n(o.midiOuts),
  };
}
function loadDb(): DbPlugin[] {
  try { const arr = JSON.parse(localStorage.getItem(KEY_DB) ?? '[]') as unknown; return Array.isArray(arr) ? arr.map(normalizePlugin).filter((p): p is DbPlugin => p !== null) : []; } catch { return []; }
}

function loadLibrary(): SavedChain[] {
  try { return parseLibrary(JSON.parse(localStorage.getItem(KEY_LIBRARY) ?? '[]') as unknown); } catch { return []; }
}

const settings: Settings = loadSettings();
let db: DbPlugin[] = loadDb();
let project: PatchProject = emptyProject({ name: 'carte', audioIn: [], audioOut: [], midiIn: [] });
let view: PatchbayView | null = null;
let lastSaved: string | null = null;
let showTab: (id: string) => void = () => undefined;
let refreshPatchbayPanel: () => void = () => undefined;

const names = (t: string): string[] => t.split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.length > 0);
const hardware = (): HardwareProfile => ({ name: 'carte', audioIn: names(settings.audioIn), audioOut: names(settings.audioOut), midiIn: names(settings.midiIn) });

const PROVIDER_LABEL: Record<api.AiProvider, string> = { anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', ollama: 'Ollama' };
const PROVIDERS: api.AiProvider[] = ['gemini', 'anthropic', 'openai', 'ollama'];
const KEY_USAGE = 'carlaWiring.usage';
const cfgOf = (p: api.AiProvider): api.AiConfig => ({
  provider: p, model: (settings.models[p] ?? '').trim(), apiKey: (settings.apiKeys[p] ?? '').trim(),
  ...(p === 'ollama' ? { baseUrl: settings.ollamaUrl.trim() || undefined, numCtx: settings.ollamaCtx } : {}),
});
/** Ollama n'a pas de clé : il faut seulement un nom de modèle. */
const ready = (c: api.AiConfig): boolean => (c.provider === 'ollama' ? c.model !== '' : c.apiKey !== '');
const missingMessage = (p: api.AiProvider, where: string): string =>
  p === 'ollama' ? `Indiquez le nom du modèle Ollama (${where}).` : `Renseignez la clé API de ${PROVIDER_LABEL[p]} ${where}.`;
/** Nombre de plugins que l'on peut envoyer à un modèle local avec la fenêtre de contexte réglée (≈ 30 jetons par plugin). */
const ollamaCatalogMax = (): number => Math.max(20, Math.min(settings.ollamaMaxPlugins, Math.floor((settings.ollamaCtx - 4500) / 30)));

/** Compteur d'appels envoyés aujourd'hui par cette application (utile pour surveiller un quota gratuit). */
function usageToday(): Record<api.AiProvider, number> {
  const day = new Date().toLocaleDateString('fr-CA');
  try {
    const u = JSON.parse(localStorage.getItem(KEY_USAGE) ?? '{}') as { day?: string; counts?: Partial<Record<api.AiProvider, number>> };
    if (u.day === day) return { anthropic: u.counts?.anthropic ?? 0, openai: u.counts?.openai ?? 0, gemini: u.counts?.gemini ?? 0, ollama: u.counts?.ollama ?? 0 };
  } catch { /* compteur illisible : on repart de zéro */ }
  return { anthropic: 0, openai: 0, gemini: 0, ollama: 0 };
}
function countCall(p: api.AiProvider): void {
  const counts = usageToday(); counts[p] += 1;
  try { localStorage.setItem(KEY_USAGE, JSON.stringify({ day: new Date().toLocaleDateString('fr-CA'), counts })); } catch { /* ignoré */ }
  refreshUsage();
}
let refreshUsage: () => void = () => undefined;

/**
 * Interroge l'IA. Si le fournisseur principal refuse pour cause de quota ou de serveur surchargé et qu'un
 * fournisseur de secours est configuré (avec sa clé), bascule dessus. Les attentes automatiques sont signalées.
 */
async function askAi(system: string, messages: api.AiMessage[], log: (l: string) => void): Promise<string> {
  const primary = cfgOf(settings.provider);
  const onWait = (s: number): void => log(`Limite de requêtes atteinte : nouvel essai automatique dans ${s} s…`);
  try {
    countCall(primary.provider);
    return await api.aiAsk(primary, system, messages, onWait);
  } catch (e) {
    const msg = errText(e);
    const backup = settings.backup && settings.backup !== settings.provider ? cfgOf(settings.backup) : null;
    if (backup && ready(backup) && /Quota|indisponible|Ollama ne répond pas/.test(msg)) {
      log(`${PROVIDER_LABEL[primary.provider]} refuse (${msg.slice(0, 90)}…) : bascule sur ${PROVIDER_LABEL[backup.provider]}.`);
      countCall(backup.provider);
      return await api.aiAsk(backup, system, messages, onWait);
    }
    throw e;
  }
}

function saveSettings(): void { try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch { /* stockage indisponible */ } }
function saveDb(): void { try { localStorage.setItem(KEY_DB, JSON.stringify(db)); } catch { /* base trop grosse */ } }
function saveProject(): void { try { localStorage.setItem(KEY_PROJECT, JSON.stringify(project)); } catch { /* ignoré */ } }
function restoreProject(): void {
  project.hardware = hardware();
  try {
    const raw = localStorage.getItem(KEY_PROJECT); if (!raw) return;
    const p = JSON.parse(raw) as PatchProject;
    if (Array.isArray(p.nodes) && Array.isArray(p.cables)) project = { ...p, hardware: hardware() };
  } catch { /* projet illisible : on repart d'un patchbay vide */ }
}
restoreProject();
let library: SavedChain[] = loadLibrary();
let openedStem = '';
const snapshot = (): string => JSON.stringify(project);
const history = new History(snapshot());
let presetIndex: PresetIndex | null = null;
let states: StatePreset[] = [];
let book: PresetBook = makeBook(null, [], db);
let refreshPresetsUi: () => void = () => undefined;
let refreshPresetInfo: () => void = () => undefined;
let refreshRoleInfo: () => void = () => undefined;
const rebuildBook = (): void => { book = makeBook(presetIndex, states, db); refreshPresetsUi(); refreshPresetInfo(); refreshRoleInfo(); };
async function loadStores(): Promise<void> {
  const [idx, st] = await Promise.all([storeRead<unknown>('presets'), storeRead<unknown>('states')]);
  presetIndex = normalizeIndex(idx); states = normalizeStates(st);
  rebuildBook();
}
/** Écrit dans le projet l'état des presets .preset de Blue Cat's choisis (si l'option est cochée). Renvoie un court message. */
async function injectPresetFiles(): Promise<string> {
  if (!settings.autoApplyBluecat) return '';
  const r = await injectFilePresets(project, (p) => api.readTextFile(p), (p) => api.readBinaryFile(p));
  if (r.applied) commit();
  return [r.applied ? `${r.applied} preset(s) appliqué(s) automatiquement.` : '', r.skipped.length ? `Non appliqué automatiquement : ${r.skipped.join(' · ')}.` : ''].filter((x) => x).join(' ');
}
const lines = (t: string): string[] => t.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
let hwFields: { inBox?: HTMLTextAreaElement; outBox?: HTMLTextAreaElement; midiBox?: HTMLTextAreaElement } = {};
let setNotices: (lines: Array<['ok' | 'warning' | 'error' | 'info', string]>) => void = () => undefined;

function saveLibrary(): void { try { localStorage.setItem(KEY_LIBRARY, JSON.stringify(library)); } catch { notify('Bibliothèque trop volumineuse pour être mémorisée.', 'err'); } }

/** À appeler après chaque changement du patchbay : mémorise, alimente annuler/rétablir, met l'écran à jour. */
function commit(): void {
  history.commit(snapshot());
  saveProject();
  view?.render();
  refreshPatchbayPanel();
}
function restoreSnapshot(state: string): void {
  try { project = JSON.parse(state) as PatchProject; } catch { return; }
  project.hardware = hardware();
  saveProject(); view?.render(); refreshPatchbayPanel();
}
function undo(): void { const s = history.undo(); if (s === null) notify('Rien à annuler.', 'info'); else { restoreSnapshot(s); notify('Annulé.', 'ok'); } }
function redo(): void { const s = history.redo(); if (s === null) notify('Rien à rétablir.', 'info'); else { restoreSnapshot(s); notify('Rétabli.', 'ok'); } }

/** Reprend les noms de ports de la carte (ex. depuis un projet ouvert) dans les réglages et les champs. */
function applyHardware(hw: HardwareProfile): void {
  settings.audioIn = hw.audioIn.join('\n'); settings.audioOut = hw.audioOut.join('\n'); settings.midiIn = hw.midiIn.join('\n');
  saveSettings();
  if (hwFields.inBox) hwFields.inBox.value = settings.audioIn;
  if (hwFields.outBox) hwFields.outBox.value = settings.audioOut;
  if (hwFields.midiBox) hwFields.midiBox.value = settings.midiIn;
  project.hardware = hardware();
}

/** Vérifie que les fichiers des plugins du patchbay existent encore sur le disque. */
async function checkPluginFiles(): Promise<Array<['ok' | 'warning' | 'error' | 'info', string]>> {
  const nodes = project.nodes.filter((n) => n.kind === 'plugin' && n.plugin?.path);
  if (!nodes.length) return [['info', 'Aucun plugin à vérifier.']];
  const found = await api.checkPaths(nodes.map((n) => n.plugin?.path ?? ''));
  const missing = nodes.filter((_, i) => found[i] === false);
  return missing.length
    ? missing.map((n): ['error', string] => ['error', `Fichier introuvable : « ${n.name} » → ${n.plugin?.path ?? ''} (plugin déplacé ou désinstallé ?)`])
    : [['ok', `Les ${nodes.length} fichier(s) de plugins existent bien.`]];
}

// ---------------------------------------------------------------------------------------------
// Petites aides d'interface

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in e) {
      // certaines propriétés (ex. `list` d'un <input>) sont en lecture seule : on retombe sur l'attribut HTML
      try { (e as unknown as Record<string, unknown>)[k] = v; } catch { e.setAttribute(k, String(v)); }
    } else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

let statusEl: HTMLElement = document.createElement('div');
function notify(msg: string, kind: 'ok' | 'err' | 'info' = 'info'): void { statusEl.textContent = msg; statusEl.className = kind; }
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function run(label: string, fn: () => Promise<void>, btn?: HTMLButtonElement): Promise<void> {
  if (btn) btn.disabled = true;
  notify(`${label}…`, 'info');
  const t0 = Date.now();
  // pendant une opération longue (IA locale, scan…), affiche le temps écoulé pour montrer que ça travaille
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - t0) / 1000);
    if (statusEl.className === 'info' && (statusEl.textContent ?? '').startsWith(`${label}…`)) {
      notify(`${label}… ${secs} s${secs >= 90 ? ' (un modèle local peut mettre plusieurs minutes : voir « Aide »)' : ''}`, 'info');
    }
  }, 1000);
  try { await fn(); } catch (e) { notify(`${label} : ${errText(e)}`, 'err'); } finally { clearInterval(timer); if (btn) btn.disabled = false; }
}
function button(label: string, onClick: (b: HTMLButtonElement) => void, primary = false, id?: string): HTMLButtonElement {
  const b = h('button', { class: primary ? 'btn primary' : 'btn', 'data-id': id }, label);
  b.addEventListener('click', () => onClick(b));
  return b;
}
const field = (label: string, input: HTMLElement): HTMLElement => h('div', {}, h('label', {}, label), input);
const card = (title: string, ...kids: Child[]): HTMLElement => h('div', { class: 'card' }, h('h2', {}, title), ...kids);
const hint = (t: string): HTMLElement => h('p', { class: 'hint' }, t);

function textBox(key: StrKey, opts: { multiline?: boolean; list?: string; placeholder?: string; password?: boolean; onInput?: () => void } = {}): HTMLInputElement | HTMLTextAreaElement {
  const el = opts.multiline
    ? h('textarea', { value: settings[key], placeholder: opts.placeholder })
    : h('input', { type: opts.password ? 'password' : 'text', value: settings[key], list: opts.list, placeholder: opts.placeholder, autocomplete: 'off' });
  el.addEventListener('input', () => { settings[key] = el.value; saveSettings(); opts.onInput?.(); });
  return el;
}

// ---------------------------------------------------------------------------------------------
// Onglet Assistant

const EXAMPLES: Array<[string, string]> = [
  ['Santana — Europa', 'Guitare électrique, lead de « Europa » de Santana : son chaud et chantant, long sustain, peu d\'attaque, médiums en avant. Un boost de type Tube Screamer devant un ampli de type Mesa/Boogie en crunch poussé (ou un plugin tout-en-un si je n\'ai pas d\'ampli), une compression douce, un égaliseur qui avance les médiums, un delay court discret et une réverbération plate. Relie la guitare aux deux entrées du premier plugin et la sortie aux deux côtés de la carte son.'],
  ['Guitare lead', 'Guitare électrique en live, son lead saturé et expressif, faible latence, un compresseur pour la dynamique, un EQ et un limiteur de sécurité en fin de chaîne.'],
  ['Clavier de scène', 'Clavier de scène : un piano réaliste et des nappes en couche, avec un EQ et un peu de réverbération discrète, et un limiteur final. Le MIDI vient de mon clavier.'],
  ['Chaîne propre', 'Chaîne propre pour un instrument acoustique en live : compresseur doux, EQ correctif, pas d\'effet marqué, limiteur de sécurité.'],
  ['Rig complet', 'Rig de scène complet : guitare (entrée de la carte son), clavier et Ketron (chacun sur son port MIDI) mélangés dans un mixeur, puis un EQ et un limiteur de sécurité en fin de chaîne, sortie stéréo.'],
];

function assistantSection(): HTMLElement {
  const logBox = h('pre', { class: 'log', 'data-id': 'log' });
  const resultBox = h('div', { 'data-id': 'result' });
  const request = h('textarea', { value: settings.request, placeholder: 'Décrivez ce que vous voulez faire : instrument, style de son, contraintes du live…', rows: 5, 'data-id': 'request' });
  request.addEventListener('input', () => { settings.request = request.value; saveSettings(); });

  const providerSel = h('select', { 'data-id': 'provider' },
    h('option', { value: 'anthropic' }, 'Claude (Anthropic)'), h('option', { value: 'openai' }, 'ChatGPT (OpenAI)'), h('option', { value: 'gemini' }, 'Gemini (Google)'), h('option', { value: 'ollama' }, 'Ollama (IA sur ce PC, gratuit, hors ligne)'));
  providerSel.value = settings.provider;
  const modelBox = h('input', { type: 'text', value: settings.models[settings.provider], autocomplete: 'off', 'data-id': 'model' });
  const keyBox = h('input', { type: 'password', value: settings.apiKeys[settings.provider], placeholder: 'clé API', autocomplete: 'off', 'data-id': 'apikey' });
  modelBox.addEventListener('input', () => { settings.models[settings.provider] = modelBox.value; saveSettings(); });
  keyBox.addEventListener('input', () => { settings.apiKeys[settings.provider] = keyBox.value; saveSettings(); });
  const keyField = field('Clé API de ce fournisseur', keyBox);
  const urlBox = h('input', { type: 'text', value: settings.ollamaUrl, 'data-id': 'ollamaurl' });
  urlBox.addEventListener('input', () => { settings.ollamaUrl = urlBox.value; saveSettings(); });
  const ctxBox = h('input', { type: 'number', value: String(settings.ollamaCtx), min: '4096', max: '65536', step: '1024', 'data-id': 'ollamactx' });
  ctxBox.addEventListener('input', () => { const v = Number(ctxBox.value); if (Number.isFinite(v) && v >= 1024) { settings.ollamaCtx = Math.floor(v); saveSettings(); } });
  const maxBox = h('input', { type: 'number', value: String(settings.ollamaMaxPlugins), min: '20', max: '600', step: '10', 'data-id': 'ollamamax' });
  maxBox.addEventListener('input', () => { const v = Number(maxBox.value); if (Number.isFinite(v) && v >= 1) { settings.ollamaMaxPlugins = Math.floor(v); saveSettings(); } });
  const ollamaField = h('div', { 'data-id': 'ollama-fields' },
    field('Adresse du serveur Ollama', urlBox), field('Mémoire de contexte (jetons)', ctxBox), field('Plugins envoyés au modèle (moins = plus rapide)', maxBox),
    hint('Aucune clé : Ollama tourne sur ce PC. 1) Installez-le (ollama.com/download/windows) et lancez-le. 2) Dans un terminal : « ollama pull » suivi du nom du modèle ci-dessus (ex. ollama pull qwen2.5:7b). 3) Revenez ici. Un contexte plus grand permet d\'envoyer plus de plugins mais consomme plus de mémoire. Les réponses sont plus lentes qu\'en ligne, surtout la première (chargement du modèle).'));
  const syncProviderUi = (): void => { const local = settings.provider === 'ollama'; keyField.hidden = local; ollamaField.hidden = !local; };
  syncProviderUi();
  providerSel.addEventListener('change', () => {
    settings.provider = providerSel.value as api.AiProvider;
    modelBox.value = settings.models[settings.provider]; keyBox.value = settings.apiKeys[settings.provider]; // chaque fournisseur garde SA clé et SON modèle
    syncProviderUi(); saveSettings();
  });
  const backupSel = h('select', { 'data-id': 'backup' }, h('option', { value: '' }, 'Aucun'),
    h('option', { value: 'anthropic' }, 'Claude (Anthropic)'), h('option', { value: 'openai' }, 'ChatGPT (OpenAI)'), h('option', { value: 'gemini' }, 'Gemini (Google)'), h('option', { value: 'ollama' }, 'Ollama (sur ce PC)'));
  backupSel.value = settings.backup;
  backupSel.addEventListener('change', () => { settings.backup = backupSel.value as api.AiProvider | ''; saveSettings(); });
  const usageLine = h('p', { class: 'hint', 'data-id': 'usage' });
  refreshUsage = () => { const u = usageToday(); usageLine.textContent = `Appels envoyés aujourd'hui par cette application : ${PROVIDERS.map((p) => `${PROVIDER_LABEL[p]} ${u[p]}`).join(' · ')}.`; };
  refreshUsage();

  const showResult = (o: GenerateOutcome): void => {
    if (!o.ok || !o.chain || !o.result) { resultBox.replaceChildren(h('p', { class: 'tag err' }, o.error ?? 'Échec')); return; }
    const w = o.result.warnings;
    resultBox.replaceChildren(...[
      h('h3', {}, o.chain.name), h('p', {}, o.chain.summary),
      o.chain.nodes.length ? h('ul', { class: 'steps' }, ...o.chain.nodes.map((n) => {
        const pl = o.result?.project.nodes.find((x) => x.id === n.id);
        return h('li', {}, h('b', {}, pl?.name ?? n.plugin), n.role ? ` — ${n.role}` : '', n.why ? ` : ${n.why}` : '',
          pl?.preset ? h('div', { class: 'hint' }, `♪ Preset : ${pl.preset.name}${pl.preset.kind === 'state' ? ' (appliqué automatiquement)' : settings.autoApplyBluecat && ((isBlueCatVst3(pl.plugin) && /\.preset$/i.test(pl.preset.path ?? '')) || (isTone3000(pl.plugin) && /\.t3kpreset$/i.test(pl.preset.path ?? ''))) ? ' (converti et appliqué automatiquement)' : ' (à charger dans le plugin)'}`) : null);
      })) : null,
      o.chain.notes.length ? h('div', {}, h('label', {}, 'Conseils pour le live'), h('ul', { class: 'steps' }, ...o.chain.notes.map((t) => h('li', {}, t)))) : null,
      o.chain.missing.length ? h('div', {}, h('label', {}, 'Ce qui manque dans votre base'), h('ul', { class: 'issues' }, ...o.chain.missing.map((t) => h('li', { class: 'warning' }, t)))) : null,
      w.length ? h('ul', { class: 'issues' }, ...w.map((t) => h('li', { class: 'warning' }, t))) : null,
      h('span', { class: 'tag ok' }, `chaîne vérifiée en ${o.attempts} essai(s)`),
      h('div', {}, button('Voir et modifier dans le Patchbay', () => showTab('patchbay'), true, 'goto-patchbay'))].filter((x): x is HTMLElement => x !== null));
  };

  const modifyChk = h('input', { type: 'checkbox', checked: settings.modifyCurrent, 'data-id': 'modify' });
  modifyChk.addEventListener('change', () => { settings.modifyCurrent = modifyChk.checked; saveSettings(); });
  const modifyRow = h('label', {}, modifyChk, ' Modifier la chaîne actuelle du Patchbay au lieu d\'en créer une nouvelle (vos réglages de plugins sont conservés)');
  // ---- Recettes de sons : sans IA, gratuit, instantané
  const recipeSel = h('select', { 'data-id': 'recipe' }, ...RECIPES.map((r) => h('option', { value: r.id }, r.label)));
  recipeSel.value = RECIPES.some((r) => r.id === settings.recipe) ? settings.recipe : (RECIPES[0] as typeof RECIPES[0]).id;
  const recipeDesc = h('p', { class: 'hint', 'data-id': 'recipe-desc' });
  const descFor = (): void => { const r = RECIPES.find((x) => x.id === recipeSel.value); recipeDesc.textContent = r ? `${r.summary} Sources : ${r.sources}.` : ''; };
  recipeSel.addEventListener('change', () => { settings.recipe = recipeSel.value; saveSettings(); descFor(); });
  descFor();
  const inputSel = h('select', { 'data-id': 'guitar-input' });
  const fillInputs = (): void => {
    const hw = hardware();
    inputSel.replaceChildren(...hw.audioIn.map((n) => h('option', { value: n }, n)));
    inputSel.value = hw.audioIn.includes(settings.guitarInput) ? settings.guitarInput : defaultGuitarInput(hw);
  };
  inputSel.addEventListener('change', () => { settings.guitarInput = inputSel.value; saveSettings(); });
  fillInputs();
  const roleInfo = h('p', { class: 'hint', 'data-id': 'roleinfo' });
  refreshRoleInfo = () => {
    const c = roleCounts(db, settings.roleOverrides);
    const parts = ROLES.filter((r) => c[r] > 0).map((r) => `${ROLE_LABEL[r].split(' (')[0]} ${c[r]}`);
    roleInfo.textContent = `Votre base : ${db.length} plugin(s)${db.length ? ` — ${parts.join(' · ') || 'aucun rôle reconnu'}${c.none ? ` · non classés ${c.none}` : ''}` : ''}.${db.length < 6 ? ' Base très petite : scannez vos dossiers (onglet Plugins).' : ''}`;
  };
  refreshRoleInfo();
  const recipeResult = h('div', { 'data-id': 'recipe-result' });
  const buildBtn = button('Construire cette recette (sans IA)', (b) => void run('Construction de la recette', async () => {
    const rc = RECIPES.find((r) => r.id === recipeSel.value);
    if (!rc) throw new Error('Choisissez une recette.');
    const res = buildFromRecipe(rc, db, hardware(), settings.usePresets ? book : undefined, { guitarInput: inputSel.value, extraWords: settings.request, roleOverrides: settings.roleOverrides });
    const missing = res.missing.map((r) => ROLE_LABEL[r]).join(', ');
    recipeResult.replaceChildren(
      h('ul', { class: 'steps' }, ...res.steps.map((s) => h('li', {}, h('b', {}, stepLabel(s)), s.plugin ? ` : ${s.plugin.name}` : '', ` — ${s.why}`,
        s.preset ? h('div', { class: 'hint' }, `♪ ${s.preset.kind === 'state' ? 'son capturé' : 'preset'} : ${s.preset.name}`) : null, s.note ? h('div', { class: 'hint' }, s.note) : null))),
      ...(res.notes.length ? [h('p', { class: 'hint' }, `Conseils de jeu : ${res.notes.join(' ')}`)] : []));
    if (!res.ok) throw new Error(`Aucun plugin utilisable pour cette recette dans votre base (manque : ${missing || 'des plugins'}). Onglet Plugins : scannez vos dossiers ou corrigez le rôle de vos plugins.`);
    const hadScenes = (project.scenes?.length ?? 0) > 0;
    project = res.project; commit();
    const injNote = await injectPresetFiles();
    notify(`Recette « ${rc.label} » construite : ${project.nodes.length} boîtes, ${project.cables.length} câbles.${missing ? ` Il manque : ${missing}.` : ''}${injNote ? ' ' + injNote : ''} Ouvrez l'onglet Patchbay.${hadScenes ? ' Les scènes précédentes ont été retirées.' : ''}`, missing ? 'info' : 'ok');
  }, b), true, 'build-recipe');
  const recipeCard = card('Recettes de sons — sans IA, gratuit, instantané',
    hint('Choisissez un son : l\'appli prend, dans VOTRE base, le plugin qui convient à chaque étape (ampli, compresseur, réverbération…), propose un preset ou un son capturé s\'il en existe, et câble tout correctement. Aucune clé, aucun quota, aucune erreur de syntaxe.'),
    field('Recette', recipeSel), recipeDesc, field('Entrée de la carte son où la guitare est branchée', inputSel), roleInfo, buildBtn, recipeResult);

  const presetChk = h('input', { type: 'checkbox', checked: settings.usePresets, 'data-id': 'usepresets' });
  presetChk.addEventListener('change', () => { settings.usePresets = presetChk.checked; saveSettings(); });
  const presetInfo = h('p', { class: 'hint', 'data-id': 'presetinfo' });
  refreshPresetInfo = () => { presetInfo.textContent = `${book.total} preset(s) indexé(s) (${book.assigned} associé(s) à vos plugins) · ${states.length} son(s) capturé(s). Onglet Presets pour en ajouter.`; };
  refreshPresetInfo();
  const presetRow = h('label', {}, presetChk, ' Laisser l\'IA proposer des presets (ceux de mon disque et mes sons capturés)');
  const go = button('Créer la chaîne avec l\'IA', (b) => void run('Création de la chaîne', async () => {
    logBox.textContent = ''; resultBox.replaceChildren();
    if (!ready(cfgOf(settings.provider))) throw new Error(missingMessage(settings.provider, 'dans « Réglages de l\'IA » (à droite)'));
    const log = (line: string): void => { logBox.textContent += line + '\n'; };
    const out = await generateChain((system, messages) => askAi(system, messages, log), settings.request, db, hardware(), log, settings.modifyCurrent ? project : undefined,
      { maxCatalog: settings.provider === 'ollama' ? ollamaCatalogMax() : undefined, presets: settings.usePresets ? book : undefined, maxPresetLines: settings.provider === 'ollama' ? 15 : 120 });
    showResult(out);
    if (!out.ok || !out.result) {
      const s = suggestRecipe(settings.request);
      if (s) { settings.recipe = s.id; saveSettings(); recipeSel.value = s.id; descFor(); }
      notify(`${out.error ?? 'Échec de la création.'} Astuce : la carte « Recettes de sons » construit ce genre de son sans IA${s ? ` (« ${s.label} » est déjà choisie pour vous)` : ''}.`, 'err');
      return;
    }
    const hadScenes = (project.scenes?.length ?? 0) > 0;
    project = out.result.project; commit();
    const injNote = await injectPresetFiles();
    notify(`Chaîne « ${out.chain?.name} » créée : ${project.nodes.length} boîtes, ${project.cables.length} câbles.${injNote ? ' ' + injNote : ''} Ouvrez l'onglet Patchbay pour la voir.${hadScenes ? ' Les scènes précédentes ont été retirées (la chaîne a changé).' : ''}`, 'ok');
  }, b), true, 'create');

  const onHw = (): void => { project.hardware = hardware(); view?.render(); fillInputs(); };
  const inBox = textBox('audioIn', { multiline: true, onInput: onHw }) as HTMLTextAreaElement;
  const outBox = textBox('audioOut', { multiline: true, onInput: onHw }) as HTMLTextAreaElement;
  const midiBox = textBox('midiIn', { multiline: true, onInput: onHw }) as HTMLTextAreaElement;
  hwFields = { inBox, outBox, midiBox };
  const importHw = button('Ports depuis un projet .carxp', (b) => void run('Lecture du projet', async () => {
    const p = await api.pickOpen('Projet Carla', ['carxp']); if (!p) return;
    const imp = importCarxp(await api.readTextFile(p));
    const ins: string[] = [], outs: string[] = [], mids: string[] = [];
    const add = (list: string[], v: string): void => { if (!list.includes(v)) list.push(v); };
    for (const [s, t] of imp.connections) for (const e of [s, t]) {
      if (e.startsWith('Audio Input:')) add(ins, e.slice('Audio Input:'.length));
      if (e.startsWith('Audio Output:')) add(outs, e.slice('Audio Output:'.length));
      if (e.startsWith('Midi Input:')) add(mids, e.slice('Midi Input:'.length));
    }
    if (ins.length) { settings.audioIn = ins.join('\n'); inBox.value = settings.audioIn; }
    if (outs.length) { settings.audioOut = outs.join('\n'); outBox.value = settings.audioOut; }
    if (mids.length) { settings.midiIn = mids.join('\n'); midiBox.value = settings.midiIn; }
    saveSettings(); onHw();
    notify(`Importé : ${ins.length} entrée(s), ${outs.length} sortie(s), ${mids.length} port(s) MIDI.`, ins.length + outs.length + mids.length ? 'ok' : 'err');
  }, b));

  return h('section', { id: 'assistant' }, h('div', { class: 'grid' },
    h('div', {}, recipeCard, card('Que voulez-vous faire ?',
      hint('Décrivez votre instrument, le son recherché et vos contraintes de live. L\'assistant ne choisit que parmi les plugins de VOTRE base (onglet Plugins) et son résultat est vérifié par le programme avant d\'être accepté.'),
      request, h('div', { class: 'chips' }, ...EXAMPLES.map(([label, text]) => button(label, () => { request.value = text; settings.request = text; saveSettings(); }))),
      modifyRow, presetRow, presetInfo, go, logBox, resultBox)),
    h('div', {},
      card('Réglages de l\'IA',
        field('Fournisseur', providerSel), field('Modèle (modifiable)', modelBox), keyField, ollamaField,
        field('Fournisseur de secours (si le quota est atteint)', backupSel), usageLine,
        hint('Chaque fournisseur garde sa clé et son modèle. La clé reste sur cet ordinateur. Votre demande et la liste de vos plugins (noms et ports, pas les fichiers) sont envoyées au fournisseur choisi ; son quota et ses tarifs s\'appliquent. Si la limite par minute est atteinte, l\'application attend et réessaie toute seule ; si le quota du jour est épuisé, elle bascule sur le fournisseur de secours (s\'il a une clé). Si un modèle est refusé, changez son nom ici.')),
      card('Ma carte son (noms de ports)',
        hint('Les noms de ports dépendent du pilote : copiez-les depuis le Patchbay de votre Carla, ou importez-les depuis un projet .carxp.'),
        field('Entrées audio (une par ligne)', inBox), field('Sorties audio', outBox), field('Entrées MIDI (groupe « Midi Input »)', midiBox), importHw))));
}

// ---------------------------------------------------------------------------------------------
// Onglet Patchbay

function patchbaySection(): HTMLElement {
  const host = h('div', { class: 'scroll canvas' });
  const issuesBox = h('ul', { class: 'issues', 'data-id': 'issues' });
  const counter = h('span', { class: 'tag', 'data-id': 'counter' });
  const zoomLabel = h('span', { class: 'tag', 'data-id': 'zoom' }, '100 %');
  const datalist = h('datalist', { id: 'db-names' });
  const picker = h('input', { type: 'text', list: 'db-names', placeholder: 'Ajouter un plugin de ma base…', 'data-id': 'picker' });

  const refresh = (): void => {
    project.hardware = hardware();
    datalist.replaceChildren(...db.map((p) => h('option', { value: p.name })));
    counter.textContent = `${project.nodes.length} boîte(s) · ${project.cables.length} câble(s)`;
    renderScenes();
    renderSelection();
    zoomLabel.textContent = `${Math.round((view?.getZoom() ?? 1) * 100)} %`;
    const issues = validateProject(project, { requirePluginFiles: true });
    const unique = [...new Map(issues.map((i) => [i.message, i])).values()];
    issuesBox.replaceChildren(...(unique.length ? unique.map((i) => h('li', { class: i.level }, i.message)) : [h('li', { class: 'info' }, project.nodes.length ? 'Aucun problème détecté.' : '')]));
  };
  // ---- Palette de couleur d'une boîte (point coloré sur la boîte)
  let popover: HTMLElement | null = null;
  const closePopover = (): void => { popover?.remove(); popover = null; };
  function showColorPopover(id: string, x: number, y: number): void {
    closePopover();
    const node = project.nodes.find((n) => n.id === id); if (!node) return;
    const sel = view?.getSelection() ?? [];
    const ids = sel.includes(id) && sel.length > 1 ? sel : [id]; // si la boîte fait partie d'une sélection multiple, la couleur s'applique à toutes
    const apply = (c: string | undefined): void => { setColor(project, ids, c); commit(); closePopover(); notify(c ? `Couleur appliquée à ${ids.length > 1 ? ids.length + ' boîtes' : '« ' + node.name + ' »'}.` : 'Couleur par défaut rétablie.', 'ok'); };
    const swatches = COLORS.map((c) => { const b = h('button', { class: 'swatch', title: c, style: `background:${c}`, 'data-id': 'pop-swatch' }); b.addEventListener('click', () => apply(c)); return b; });
    const custom = h('input', { type: 'color', value: node.color ?? '#22d3ee', 'data-id': 'pop-custom', title: 'Autre couleur' });
    custom.addEventListener('change', () => apply(custom.value));
    const pop = h('div', { class: 'popover', 'data-id': 'colorpop', style: `left:${Math.max(8, Math.min(x - 20, window.innerWidth - 270))}px;top:${y + 14}px` },
      h('p', { class: 'hint' }, ids.length > 1 ? `Couleur des ${ids.length} boîtes sélectionnées` : `Couleur de « ${node.name} »`),
      h('div', {}, ...swatches), h('div', { class: 'row2' }, custom, h('span', { class: 'hint' }, 'autre couleur'),
        button('Par défaut', () => apply(undefined), false, 'pop-reset'), button('Fermer', closePopover, false, 'pop-close')));
    document.body.append(pop); popover = pop;
    const outside = (ev: Event): void => { if (popover && !popover.contains(ev.target as Node)) { closePopover(); document.removeEventListener('mousedown', outside, true); } };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { closePopover(); document.removeEventListener('keydown', esc); } });
  }

  // ---- Panneau de sélection : couleur, alignement, preset
  const selBox = h('div', { class: 'card', 'data-id': 'selpanel' });
  function renderSelection(): void {
    const ids = view?.getSelection() ?? [];
    const nodes = project.nodes.filter((n) => ids.includes(n.id));
    if (!nodes.length) {
      selBox.replaceChildren(h('h2', {}, 'Sélection'), hint('Cliquez l\'en-tête d\'une boîte (Maj+clic pour en ajouter) ou tirez un cadre sur le fond pour la sélectionner : couleur, alignement, preset. Pour créer un câble, appuyez sur un port et glissez jusqu\'à un autre port.'));
      return;
    }
    const first = nodes[0] as typeof nodes[0];
    const swatches = COLORS.map((c) => {
      const b = h('button', { class: 'swatch', title: c, style: `background:${c}`, 'data-id': 'swatch' });
      b.addEventListener('click', () => { setColor(project, ids, c); commit(); });
      return b;
    });
    const picker2 = h('input', { type: 'color', value: first.color ?? '#22d3ee', 'data-id': 'colorpick', title: 'Autre couleur' });
    picker2.addEventListener('change', () => { setColor(project, ids, picker2.value); commit(); });
    const al = (label: string, mode: AlignMode): HTMLButtonElement => button(label, () => { if (alignNodes(project, ids, mode)) commit(); else notify('Sélectionnez au moins 2 boîtes pour les aligner.', 'err'); }, false, `align-${mode}`);
    const dist = (label: string, axis: 'x' | 'y'): HTMLButtonElement => button(label, () => { if (distributeNodes(project, ids, axis)) commit(); else notify('Sélectionnez au moins 3 boîtes pour les répartir.', 'err'); }, false, `dist-${axis}`);
    const kids: Child[] = [
      h('h2', {}, nodes.length === 1 ? first.name : `${nodes.length} boîtes sélectionnées`),
      first.plugin ? hint(`${first.plugin.type}${first.plugin.path ? ' — ' + first.plugin.path : ''}`) : null,
      h('label', {}, 'Couleur'), h('div', { class: 'seltools' }, ...swatches, picker2, button('Défaut', () => { setColor(project, ids, undefined); commit(); }, false, 'color-reset')),
      h('label', {}, 'Organiser'), h('div', { class: 'seltools' }, al('⇤ Gauche', 'left'), al('⇥ Droite', 'right'), al('↔ Centrer', 'centerX'), al('⤒ Haut', 'top'), al('⤓ Bas', 'bottom'), al('↕ Centrer', 'centerY'),
        dist('Répartir ↔', 'x'), dist('Répartir ↕', 'y'), button('Aimanter', () => { snapNodes(project, ids, 20); commit(); }, false, 'snap-now')),
    ];
    if (nodes.length === 1 && first.kind === 'plugin' && first.plugin) {
      const node = first;
      const cands = book.forPlugin(first.plugin, '', 300);
      const sel = h('select', { 'data-id': 'presetpick' }, h('option', { value: '' }, cands.length ? '— choisir un preset —' : '— aucun preset connu pour ce plugin —'),
        ...cands.map((c, i) => h('option', { value: String(i) }, `${c.kind === 'state' ? '[son capturé] ' : '[fichier] '}${c.collection ? c.collection + ' — ' : ''}${c.name}`)));
      sel.addEventListener('change', () => {
        const c = cands[Number(sel.value)]; if (!c) return;
        applyPreset(node, c); commit();
        const plain = c.kind === 'state' ? `Son « ${c.name} » appliqué : l'état du plugin sera écrit dans le .carxp.` : `Preset « ${c.name} » noté : fichier à charger dans le plugin (${c.path ?? ''}).`;
        if (c.kind === 'file' && settings.autoApplyBluecat) void injectPresetFiles().then((note) => notify(note.startsWith('1 preset') ? `Preset « ${c.name} » appliqué automatiquement : son état sera écrit dans le .carxp.` : `${plain} ${note}`.trim(), 'ok')).catch((e) => notify(errText(e), 'err'));
        else notify(plain, 'ok');
      });
      kids.push(h('label', {}, 'Preset'), sel,
        node.preset ? h('p', { class: 'hint' }, `Actuel : ${node.preset.name} (${node.preset.kind === 'state' ? 'son capturé, appliqué' : node.preset.applied ? 'fichier .preset converti, appliqué' : 'fichier, à charger dans le plugin'})`) : null,
        node.preset ? button('Retirer le preset', () => { clearPreset(node); commit(); }, false, 'preset-clear') : null);
    }
    selBox.replaceChildren(...(kids.filter((k) => k) as Node[]));
  }
  refreshPatchbayPanel = refresh;
  const changed = (): void => { commit(); };
  view = mountPatchbay(host, () => project, {
    onChange: changed, onMessage: notify, onSelect: () => renderSelection(), snap: () => settings.snapGrid, onColor: (id, x, y) => showColorPopover(id, x, y),
    onReplace: (id) => {
      const plugin = db.find((x) => x.name === picker.value.trim());
      if (!plugin) { notify('Choisissez d\'abord le plugin de remplacement dans le champ « Ajouter un plugin… » de la barre d\'outils, puis cliquez sur ⇄ sur la boîte à remplacer.', 'err'); return; }
      const r = replacePlugin(project, id, plugin);
      if (r.error) { notify(r.error, 'err'); return; }
      picker.value = ''; commit();
      setNotices([['ok', `Remplacé par « ${plugin.name} » : ${r.kept} câble(s) conservé(s).`], ...r.dropped.map((d): ['warning', string] => ['warning', `Câble abandonné (port absent du nouveau plugin) : ${d}`]),
        ['info', 'Les réglages sauvegardés de l\'ancien plugin ne sont pas transférés : le nouveau part de ses réglages par défaut.']]);
      notify(`Plugin remplacé par « ${plugin.name} »${r.dropped.length ? ` (${r.dropped.length} câble(s) abandonné(s))` : ''}.`, r.dropped.length ? 'info' : 'ok');
    },
  });

  const sceneName = h('input', { type: 'text', placeholder: 'Nom de la scène (ex. Clair, Saturé, Solo)', 'data-id': 'scenename' });
  const sceneAsk = h('input', { type: 'text', placeholder: 'Demander à l\'IA des variantes (ex. clair, saturé, solo)', 'data-id': 'sceneask' });
  const sceneList = h('div', { class: 'chips', 'data-id': 'scenes' });
  function renderScenes(): void {
    const scenes = project.scenes ?? [];
    sceneList.replaceChildren(...(scenes.length ? scenes.map((sc) => h('span', { class: 'scene', 'data-scene': sc.id },
      button(sc.name, () => { const r = applyScene(project, sc.id); commit(); notify(`Scène « ${sc.name} » appliquée${r.ignored ? ` (${r.ignored} câble(s) ignoré(s) : plugin ou port supprimé)` : ''}.`, r.ignored ? 'info' : 'ok'); }, true, 'scene-apply'),
      button('↻', () => { saveScene(project, sc.name); commit(); notify(`Scène « ${sc.name} » mise à jour avec l'état actuel.`, 'ok'); }, false, 'scene-update'),
      button('×', () => { removeScene(project, sc.id); commit(); notify(`Scène « ${sc.name} » supprimée.`, 'info'); }, false, 'scene-del'))) : [hint('Aucune scène. Réglez le patchbay (plugins contournés, câblage), donnez un nom, puis « Enregistrer la scène ».')]));
  }
  const saveSceneBtn = button('Enregistrer la scène', () => {
    const err = saveScene(project, sceneName.value);
    if (err) { notify(err, 'err'); return; }
    const nm = sceneName.value.trim(); sceneName.value = ''; commit(); notify(`Scène « ${nm} » enregistrée (contournements + câblage actuels).`, 'ok');
  }, false, 'scene-save');
  const exportScenes = button('Exporter toutes les scènes (.carxp)', (b) => void run('Export des scènes', async () => {
    const scenes = project.scenes ?? [];
    if (!scenes.length) throw new Error('Aucune scène à exporter.');
    const problems = scenes.flatMap((sc) => validateScene(project, sc.id).map((m) => `Scène « ${sc.name} » : ${m}`));
    if (problems.length) throw new Error(problems.join(' | '));
    const folder = await api.pickFolder(); if (!folder) return;
    const sep = folder.includes('\\') ? '\\' : '/';
    const base = folder.replace(/[\\/]+$/, '');
    const files = planSceneFiles(project, openedStem || 'ma_chaine', settings.centerForCarla);
    for (const f of files) await api.writeTextFile(`${base}${sep}${f.fileName}`, f.xml);
    setNotices(files.map((f): ['ok', string] => ['ok', `${f.scene.name} → ${f.fileName}`]));
    notify(`${files.length} fichier(s) .carxp écrit(s) dans ${base}.`, 'ok');
  }, b), false, 'scene-export');
  const aiScenes = button('Proposer des variantes (IA)', (b) => void run('Création des scènes', async () => {
    if (!ready(cfgOf(settings.provider))) throw new Error(missingMessage(settings.provider, 'dans l\'onglet Assistant'));
    const log = (l: string): void => notify(l, 'info');
    const o = await generateScenes((system, messages) => askAi(system, messages, log), sceneAsk.value, project, log);
    if (!o.ok || !o.scenes) throw new Error(o.error ?? 'Échec.');
    addProposedScenes(project, o.scenes); commit();
    setNotices([...o.scenes.map((sc): ['info', string] => ['info', `${sc.name}${sc.why ? ' — ' + sc.why : ''}`]), ...(o.notes ?? []).map((t): ['info', string] => ['info', t])]);
    notify(`${o.scenes.length} scène(s) ajoutée(s) (vérifiées en ${o.attempts} essai(s)). Cliquez-les pour les essayer.`, 'ok');
  }, b), false, 'scene-ai');
  const noticeBox = h('ul', { class: 'issues', 'data-id': 'notices' });
  setNotices = (lines) => noticeBox.replaceChildren(...lines.map(([k, t]) => h('li', { class: k }, t)));
  const open = button('Ouvrir un .carxp', (b) => void run('Ouverture du projet', async () => {
    const path = await api.pickOpen('Projet Carla', ['carxp']); if (!path) return;
    const r = projectFromCarxp(await api.readTextFile(path), db, hardware());
    applyHardware(r.hardware);
    project = r.project; project.hardware = hardware(); openedStem = path.replace(/^.*[\\/]/, '').replace(/\.carxp$/i, '');
    commit();
    const lines: Array<['ok' | 'warning' | 'error' | 'info', string]> = r.warnings.map((w): ['warning', string] => ['warning', w]);
    notify(`Projet « ${openedStem} » ouvert : ${project.nodes.filter((n) => n.kind === 'plugin').length} plugin(s), ${project.cables.length} câble(s). Vos réglages de plugins seront conservés à l'enregistrement.`, 'ok');
    try { lines.push(...(await checkPluginFiles())); } catch { /* vérification impossible hors de l'application */ }
    setNotices(lines);
  }, b), false, 'open');
  const undoBtn = button('↶ Annuler', () => undo(), false, 'undo');
  const redoBtn = button('↷ Rétablir', () => redo(), false, 'redo');
  const verify = button('Vérifier les plugins', (b) => void run('Vérification des fichiers', async () => {
    const lines = await checkPluginFiles(); setNotices(lines);
    notify(lines.some(([k]) => k === 'error') ? 'Des fichiers de plugins sont introuvables (voir la liste).' : 'Vérification terminée.', lines.some(([k]) => k === 'error') ? 'err' : 'ok');
  }, b), false, 'verify');
  const sheet = button('Fiche (.md)', (b) => void run('Fiche de la chaîne', async () => {
    if (!project.nodes.some((n) => n.kind === 'plugin')) throw new Error('Le patchbay ne contient aucun plugin.');
    const path = await api.pickSave('fiche_chaine.md', 'Fiche', ['md']); if (!path) return;
    await api.writeTextFile(path, chainSheet(project, openedStem || undefined)); notify(`Fiche enregistrée : ${path}`, 'ok');
  }, b), false, 'sheet');
  const addBtn = button('Ajouter', () => {
    const p = db.find((x) => x.name === picker.value.trim());
    if (!p) { notify(db.length ? `« ${picker.value} » n'est pas dans votre base de plugins.` : 'Votre base est vide : scannez vos plugins (onglet Plugins).', 'err'); return; }
    addPlugin(project, p); picker.value = ''; autoLayout(project); view?.render(); changed();
  }, false, 'add');
  const hwBtn = (kind: HwKind, label: string): HTMLButtonElement => button(label, () => { ensureHardware(project, kind); autoLayout(project); view?.render(); changed(); notify(`« ${HW_NAMES[kind]} » ajouté.`, 'ok'); });
  const layout = button('Auto-disposition', () => { autoLayout(project); view?.render(); changed(); });
  const monoBtn = button('Mono → stéréo', () => { const n = fanOutMono(project); if (n) { commit(); notify(`${n} câble(s) ajouté(s) : le son des plugins mono sort maintenant des deux côtés.`, 'ok'); } else notify('Rien à corriger : aucun plugin mono n\'est relié à un seul côté.', 'info'); }, false, 'mono-stereo');
  const clear = button('Vider', () => {
    // repart d'un projet neuf : plus de scènes, plus d'en-tête ni de fin de fichier du projet ouvert
    project.nodes = []; project.cables = []; project.scenes = []; project.base = undefined; project.meta = undefined; openedStem = '';
    view?.render(); changed(); notify('Patchbay vidé.', 'info');
  });
  const save = button('Enregistrer en .carxp', (b) => void run('Enregistrement', async () => {
    const errs = validateProject(project, { requirePluginFiles: true }).filter((i) => i.level === 'error');
    if (errs.length) throw new Error([...new Set(errs.map((e) => e.message))].join(' | '));
    if (!project.nodes.some((n) => n.kind === 'plugin')) throw new Error('Le patchbay ne contient aucun plugin.');
    const p = await api.pickSave(openedStem ? `${openedStem}_modifie.carxp` : 'ma_chaine.carxp', 'Projet Carla', ['carxp']); if (!p) return;
    await api.writeTextFile(p, exportCarxp(project, true, { center: settings.centerForCarla })); lastSaved = p; notify(`Enregistré : ${p}`, 'ok');
  }, b), true, 'save');
  const launch = button('Ouvrir dans Carla', (b) => void run('Lancement de Carla', async () => {
    if (!lastSaved) throw new Error('Enregistrez d\'abord le projet en .carxp.');
    if (!settings.carlaExe) { const p = await api.pickOpen('Carla', ['exe']); if (!p) return; settings.carlaExe = p; saveSettings(); }
    await api.launchCarla(settings.carlaExe, lastSaved); notify('Carla lancé.', 'ok');
  }, b));

  const setZ = (z: number): void => { view?.setZoom(z); zoomLabel.textContent = `${Math.round((view?.getZoom() ?? 1) * 100)} %`; };
  const zoomOut = button('−', () => setZ((view?.getZoom() ?? 1) - 0.1), false, 'zoom-out');
  const zoomIn = button('+', () => setZ((view?.getZoom() ?? 1) + 0.1), false, 'zoom-in');
  const zoomReset = button('100 %', () => setZ(1), false, 'zoom-reset');
  const centerBtn = button('Centrer la vue', () => view?.center(), false, 'center-view');
  const colorRole = button('Couleurs par rôle', () => { colorByRole(project); commit(); notify('Instruments en ambre, effets en cyan, carte son en gris.', 'ok'); }, false, 'color-role');
  const colorClear = button('Effacer les couleurs', () => { setColor(project, project.nodes.map((n) => n.id), undefined); commit(); notify('Couleurs effacées.', 'info'); }, false, 'color-clear');
  const selectAll = button('Tout sélectionner', () => view?.setSelection(project.nodes.map((n) => n.id)), false, 'select-all');
  const mkChk = (key: 'snapGrid' | 'centerForCarla', label: string, id: string): HTMLElement => {
    const c = h('input', { type: 'checkbox', checked: settings[key], 'data-id': id });
    c.addEventListener('change', () => { settings[key] = c.checked; saveSettings(); });
    return h('label', { class: 'inl' }, c, ` ${label}`);
  };
  refresh();
  return h('section', { id: 'patchbay', hidden: true }, datalist,
    h('div', { class: 'toolbar' }, picker, addBtn, hwBtn('hw-in', '+ Entrée carte'), hwBtn('hw-out', '+ Sortie carte'), hwBtn('midi-in', '+ MIDI'), layout, monoBtn, clear),
    h('div', { class: 'toolbar' }, open, undoBtn, redoBtn, verify, sheet, save, launch, counter),
    h('div', { class: 'toolbar' }, zoomOut, zoomLabel, zoomIn, zoomReset, centerBtn, selectAll, colorRole, colorClear, mkChk('snapGrid', 'Aimanter à la grille', 'snap'), mkChk('centerForCarla', 'Centrer dans Carla à l\'enregistrement', 'center-carla')),
    hint('Le point sur chaque boîte ouvre sa palette de couleur · tirez un câble : appuyez sur un port, glissez jusqu\'à un autre port · glissez l\'en-tête d\'une boîte pour la déplacer (Maj+clic ou cadre = sélection multiple) · double-clic sur un câble pour le supprimer · Suppr efface la sélection · ⏻ contourne · ⇄ remplace · × supprime · Ctrl+molette = zoom.'),
    selBox,
    h('div', { class: 'card' }, h('h2', {}, 'Scènes (variantes pour le live)'),
      hint('Une scène = un état du rig : quels plugins sont contournés et quel câblage est actif (son clair, saturé, solo…). Chaque scène s\'exporte en fichier .carxp séparé à ouvrir dans Carla selon le morceau. ⇄ sur une boîte : remplacer un plugin (choisissez d\'abord le nouveau dans « Ajouter un plugin… »).'),
      h('div', { class: 'row' }, sceneName, saveSceneBtn), sceneList, h('div', { class: 'row' }, sceneAsk, aiScenes), exportScenes),
    noticeBox, host, issuesBox);
}

// ---------------------------------------------------------------------------------------------
// Onglet Mes chaînes

function chainsSection(): HTMLElement {
  const listBox = h('div', { 'data-id': 'chains' });
  const nameBox = h('input', { type: 'text', placeholder: 'Nom de la chaîne (ex. Basse – concert du 12)', 'data-id': 'chainname' });
  const fmt = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR'); };

  const render = (): void => {
    if (!library.length) { listBox.replaceChildren(hint('Aucune chaîne enregistrée pour l\'instant.')); return; }
    listBox.replaceChildren(...library.map((c) => {
      const plugs = c.project.nodes.filter((n) => n.kind === 'plugin').length;
      return h('div', { class: 'driver', 'data-chain': c.id },
        h('div', { class: 't' }, c.name, h('span', { class: 'tag' }, `${plugs} plugin(s) · ${c.project.cables.length} câble(s)`), c.savedAt && h('span', { class: 'tag' }, fmt(c.savedAt))),
        button('Charger', () => {
          const pr = loadChain(library, c.id); if (!pr) return;
          project = pr; applyHardware(pr.hardware); openedStem = ''; commit(); showTab('patchbay');
          notify(`Chaîne « ${c.name} » chargée (annulable). Les noms de ports de la carte ont été repris de cette chaîne.`, 'ok');
        }, true, 'load'),
        button('Dupliquer', () => { library = duplicateChain(library, c.id); saveLibrary(); render(); }, false, 'dup'),
        button('Supprimer', () => { library = removeChain(library, c.id); saveLibrary(); render(); notify(`« ${c.name} » supprimée.`, 'info'); }, false, 'del'));
    }));
  };
  const saveBtn = button('Enregistrer le patchbay actuel', () => {
    try {
      if (!project.nodes.length) throw new Error('Le patchbay est vide.');
      const existed = library.some((c) => c.name.toLowerCase() === nameBox.value.trim().toLowerCase());
      library = saveChain(library, nameBox.value, project); saveLibrary(); render();
      notify(existed ? `Chaîne « ${nameBox.value.trim()} » remplacée.` : `Chaîne « ${nameBox.value.trim()} » enregistrée.`, 'ok'); nameBox.value = '';
    } catch (e) { notify(errText(e), 'err'); }
  }, true, 'savechain');
  const exportBtn = button('Exporter mes chaînes (fichier)', (b) => void run('Export des chaînes', async () => {
    if (!library.length) throw new Error('Aucune chaîne à exporter.');
    const path = await api.pickSave('mes_chaines.json', 'Mes chaînes', ['json']); if (!path) return;
    await api.writeTextFile(path, serializeLibrary(library)); notify(`Chaînes enregistrées : ${path}`, 'ok');
  }, b), false, 'exportchains');
  const importBtn = button('Importer des chaînes', (b) => void run('Import des chaînes', async () => {
    const path = await api.pickOpen('Mes chaînes', ['json']); if (!path) return;
    const r = importChains(library, await api.readTextFile(path)); library = r.list; saveLibrary(); render();
    notify(r.added ? `${r.added} chaîne(s) importée(s).` : 'Aucune chaîne valide dans ce fichier.', r.added ? 'ok' : 'err');
  }, b), false, 'importchains');

  render();
  return h('section', { id: 'chaines', hidden: true }, h('div', { class: 'grid' },
    card('Enregistrer le patchbay actuel',
      hint('Gardez vos chaînes d\'un concert à l\'autre. Un nom déjà utilisé remplace la chaîne existante. Elles restent sur cet ordinateur ; exportez-les en fichier pour les sauvegarder ou les déplacer.'),
      nameBox, saveBtn, exportBtn, importBtn),
    card('Mes chaînes', listBox)));
}

// ---------------------------------------------------------------------------------------------
// Onglet Presets

/** Avertit quand la bibliothèque de sons capturés devient lourde (un état TONE3000 pèse environ 2 Mo : les modèles y sont embarqués). */
function statesSizeNote(): string {
  const mo = (states.reduce((n, s) => n + s.chunk.length, 0) * 0.75) / 1e6;
  return mo >= 50 ? ` Attention : vos sons capturés pèsent ${mo.toFixed(0)} Mo ; au-delà de quelques centaines de Mo le démarrage ralentit (supprimez ceux dont vous ne vous servez pas).` : '';
}

function presetsSection(): HTMLElement {
  const modeSel = h('select', { 'data-id': 'presetmode' }, h('option', { value: 'dossiers' }, 'Dossiers précis (recommandé)'), h('option', { value: 'disque' }, 'Disque entier (long)'));
  modeSel.value = settings.presetMode;
  const foldersBox = textBox('presetRoots', { multiline: true }) as HTMLTextAreaElement;
  const foldersField = field('Dossiers à scanner (un par ligne)', foldersBox);
  const diskField = field('Disque ou dossier de départ (ex. C:\\)', textBox('diskRoot'));
  const warn = hint('Un disque entier contient des centaines de milliers de fichiers : le scan peut durer plusieurs minutes, surtout sur un disque dur. Les dossiers système sont ignorés et les raccourcis ne sont pas suivis. Vous pouvez l\'arrêter à tout moment : les fichiers déjà trouvés sont conservés.');
  const syncMode = (): void => { const d = settings.presetMode === 'disque'; foldersField.hidden = d; diskField.hidden = !d; warn.hidden = !d; };
  syncMode();
  modeSel.addEventListener('change', () => { settings.presetMode = modeSel.value as 'dossiers' | 'disque'; saveSettings(); syncMode(); });
  const extsBox = textBox('presetExts') as HTMLInputElement;
  const progress = h('div'); const progressTxt = h('div', { class: 'hint' });
  const summary = h('p', { class: 'hint', 'data-id': 'presetsummary' });
  const tableBox = h('div', { class: 'scroll' }); const unassignedBox = h('div'); const extBox = h('div', { 'data-id': 'extresult' }); const subBox = h('div', { 'data-id': 'subresult' });
  const statesBox = h('div', { 'data-id': 'states' });
  const filter = h('input', { type: 'text', placeholder: 'Filtrer par plugin…' });

  const render = (): void => {
    const date = presetIndex?.scannedAt ? new Date(presetIndex.scannedAt).toLocaleString('fr-FR') : '';
    summary.textContent = presetIndex
      ? `${book.total} fichier(s) de presets indexé(s)${date ? ` le ${date}` : ''} : ${book.assigned} associé(s) à un plugin de votre base, ${book.unassigned.length} non associé(s).${presetIndex.truncated ? ' ATTENTION : scan interrompu (trop de fichiers), restreignez les dossiers.' : ''} ${states.length} son(s) capturé(s).`
      : `Aucun preset indexé. Choisissez où chercher puis « Scanner les presets ». ${states.length} son(s) capturé(s).`;
    const q = filter.value.trim().toLowerCase();
    const rows = db.map((p) => ({ p, n: book.countFor(p) })).filter((r) => r.n > 0 && (!q || r.p.name.toLowerCase().includes(q))).sort((a, b) => b.n - a.n).slice(0, 300);
    tableBox.replaceChildren(rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ...['Plugin', 'Presets', 'Exemples'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, r.p.name), h('td', {}, String(r.n)), h('td', {}, book.forPlugin(r.p, '', 3).map((c) => c.name).join(' · '))))))
      : hint(presetIndex ? 'Aucun preset associé à vos plugins pour ce filtre. Scannez d\'abord vos plugins (onglet Plugins) : l\'association se fait par le nom du dossier ou, pour les .fxp/.fxb, par l\'identifiant du plugin.' : ''));
    unassignedBox.replaceChildren(book.unassigned.length
      ? h('details', {}, h('summary', {}, `${book.unassigned.length} fichier(s) non associé(s) à un plugin`),
        hint('Leur dossier ne correspond à aucun plugin de votre base (nom inconnu). Ils restent indexés mais ne sont pas proposés à l\'IA.'),
        h('ul', { class: 'issues' }, ...book.unassigned.slice(0, 100).map((e) => h('li', { class: 'info' }, `${e.name} — ${e.path}`))))
      : null as unknown as Node);
    statesBox.replaceChildren(states.length ? h('div', {}, ...states.map((s) => {
      const name = h('input', { type: 'text', value: s.name });
      name.addEventListener('change', () => { s.name = name.value.trim() || s.name; void storeWrite('states', states).then(rebuildBook).catch((e) => notify(errText(e), 'err')); });
      const del = button('Supprimer', () => { states = states.filter((x) => x.id !== s.id); void storeWrite('states', states).then(rebuildBook).catch((e) => notify(errText(e), 'err')); }, false, 'state-del');
      return h('div', { class: 'driver', 'data-state': s.id }, name, h('div', { class: 'd' }, `${s.pluginName} — depuis « ${s.source} » — ${(() => { const ko = Math.max(1, Math.round(s.chunk.length / 1365)); return ko >= 1024 ? (ko / 1024).toFixed(1) + ' Mo' : ko + ' Ko'; })()}`), del);
    })) : hint('Aucun son capturé. Enregistrez un projet dans Carla avec le plugin réglé comme vous l\'aimez, puis capturez-le ici.'));
  };
  refreshPresetsUi = render;
  filter.addEventListener('input', render);

  const scan = button('Scanner les presets', (b) => void run('Scan des presets', async () => {
    const roots = settings.presetMode === 'disque' ? [settings.diskRoot.trim()].filter((r) => r) : lines(settings.presetRoots);
    if (!roots.length) throw new Error('Indiquez au moins un dossier à scanner.');
    const exts = names(settings.presetExts);
    const rep = await api.scanPresets(roots, exts, (p) => {
      progressBar(p.dirs, p.found); progressTxt.textContent = `${p.dirs} dossier(s) parcouru(s), ${p.found} preset(s) trouvé(s)${p.current ? ' — ' + p.current : ''}`;
    });
    presetIndex = { version: 1, scannedAt: new Date().toISOString(), roots, extensions: exts, truncated: rep.truncated, entries: rep.entries };
    await storeWrite('presets', presetIndex); rebuildBook();
    notify(`${rep.entries.length} fichier(s) de presets trouvé(s) dans ${rep.visitedDirs} dossier(s)${rep.cancelled ? ' (scan arrêté)' : ''}${rep.truncated ? ' (limite atteinte : restreignez les dossiers)' : ''}${rep.unreadable ? `, ${rep.unreadable} dossier(s) illisible(s)` : ''}.`, rep.truncated ? 'info' : 'ok');
  }, b), true, 'scan-presets');
  const progressBar = (dirs: number, found: number): void => { progress.replaceChildren(h('div', { class: 'bar' }, h('div', { style: `width:${Math.min(95, 5 + Math.round(Math.log10(1 + dirs) * 18))}%` }))); void found; };
  const stop = button('Arrêter', () => void api.cancelPresetScan().then(() => notify('Arrêt demandé…', 'info')).catch((e) => notify(errText(e), 'err')), false, 'stop-presets');
  const reset = button('Effacer l\'index', () => { presetIndex = null; void storeWrite('presets', null).then(rebuildBook).catch((e) => notify(errText(e), 'err')); notify('Index des presets effacé.', 'info'); }, false, 'reset-presets');

  const analyse = button('Analyser un dossier (découvrir les formats)', (b) => void run('Analyse du dossier', async () => {
    const root = settings.presetMode === 'disque' ? settings.diskRoot.trim() : (lines(settings.presetRoots)[0] ?? '');
    if (!root) throw new Error('Indiquez d\'abord un dossier.');
    const rows = await api.scanExtensions(root);
    const addExt = (ext: string): void => {
      const cur = names(settings.presetExts);
      if (!cur.includes(ext)) { settings.presetExts = [...cur, ext].join(','); extsBox.value = settings.presetExts; saveSettings(); }
    };
    const body = rows.map((r) => {
      const action = r.ext.startsWith('(') ? '' : button('Ajouter', () => addExt(r.ext), false, 'ext-add');
      return h('tr', {}, h('td', {}, r.ext), h('td', {}, String(r.count)), h('td', {}, r.example), h('td', {}, action));
    });
    const head = h('thead', {}, h('tr', {}, ...['Extension', 'Nombre', 'Exemple', ''].map((t) => h('th', {}, t))));
    extBox.replaceChildren(rows.length
      ? h('div', {}, hint(`Extensions trouvées dans ${root} (les plus fréquentes). Cliquez « Ajouter » pour chercher aussi ce format.`), h('table', {}, head, h('tbody', {}, ...body)))
      : hint('Dossier vide.'));
    // détail sous-dossier par sous-dossier (ex. Guitar Rig 7\Content : un dossier par composant)
    const subs = await api.analyseSubfolders(root);
    const subRows = subs.slice(0, 60).map((sf) => {
      const c = classifyExts(sf.exts);
      const chip = (e: { ext: string; count: number }, cls: string): HTMLElement => h('span', { class: `tag ${cls}` }, `.${e.ext} ×${e.count}`);
      return h('div', { class: 'driver', 'data-sub': sf.name },
        h('div', { class: 't' }, sf.name), h('div', { class: 'd' }, `${sf.files} fichier(s)`),
        h('div', {}, ...c.likely.map((e) => chip(e, 'ok')), ...c.other.map((e) => chip(e, 'warn')), ...c.noise.map((e) => chip(e, ''))),
        h('div', {}, button('Utiliser ce sous-dossier', () => { addRoot(sf.path); for (const e of c.likely) addExtension(e.ext); notify(`Sous-dossier ajouté${c.likely.length ? ` avec ${c.likely.map((e) => '.' + e.ext).join(', ')}` : ''}.`, 'ok'); }, true, 'sub-use'),
          ...c.other.map((e) => button(`+ .${e.ext} (${e.count})`, () => addExtension(e.ext), false, 'sub-ext'))));
    });
    subBox.replaceChildren(subs.length ? h('div', {}, hint('Détail par sous-dossier : choisissez ceux qui contiennent des presets (vert) ou des formats à vérifier (jaune).'), ...subRows) : null as unknown as Node);
    notify(`${rows.length} type(s) de fichiers trouvé(s) dans ${subs.length} sous-dossier(s).`, 'ok');
  }, b), false, 'scan-ext');

  // ---- découverte automatique par plugin
  const discoverBox = h('div', { 'data-id': 'discover' });
  const autoChk = h('input', { type: 'checkbox', checked: settings.autoApplyBluecat, 'data-id': 'auto-bluecat' });
  autoChk.addEventListener('change', () => { settings.autoApplyBluecat = autoChk.checked; saveSettings(); });
  const addRoot = (path: string): void => { const cur = lines(settings.presetRoots); if (!cur.includes(path)) { settings.presetRoots = [...cur, path].join('\n'); foldersBox.value = settings.presetRoots; } settings.presetMode = 'dossiers'; modeSel.value = 'dossiers'; syncMode(); saveSettings(); };
  const addExtension = (ext: string): void => { const cur = names(settings.presetExts); if (!cur.includes(ext)) { settings.presetExts = [...cur, ext].join(','); extsBox.value = settings.presetExts; saveSettings(); } };
  const discover = button('Découvrir automatiquement (pour mes plugins)', (b) => void run('Découverte des presets', async () => {
    if (!db.length) throw new Error('Votre base de plugins est vide : scannez d\'abord vos plugins (onglet Plugins).');
    const found = await api.discoverPresetDirs(hintsFromDb(db), lines(settings.presetRoots));
    if (!found.length) { discoverBox.replaceChildren(hint('Aucun dossier correspondant à vos plugins dans les emplacements habituels (AppData, ProgramData, Documents, dossiers VST). Utilisez « Dossiers précis » avec le dossier de données du plugin.')); notify('Aucun dossier trouvé.', 'info'); return; }
    const rank = (d: api.DiscoveredDir): number => (classifyExts(d.exts).likely.length ? 4 : 0) + (pluginsForDir(d.name, db).length ? 2 : 0) + (d.files > 0 ? 1 : 0);
    const ordered = [...found].sort((a, b) => rank(b) - rank(a) || b.files - a.files);
    const rows = ordered.slice(0, 80).map((d) => {
      const c = classifyExts(d.exts);
      const plugs = pluginsForDir(d.name, db).map((p) => p.name);
      const chip = (e: { ext: string; count: number }, cls: string): HTMLElement => h('span', { class: `tag ${cls}` }, `.${e.ext} ×${e.count}`);
      const otherBtns = c.other.map((e) => button(`+ .${e.ext} (${e.count})`, () => addExtension(e.ext), false, 'disc-ext'));
      return h('div', { class: 'driver', 'data-dir': d.path },
        h('div', { class: 't' }, d.name, plugs.length ? h('span', { class: 'tag ok' }, plugs.slice(0, 3).join(', ')) : h('span', { class: 'tag' }, 'éditeur ou plugin non identifié')),
        h('div', { class: 'd' }, `${d.path} — ${d.files} fichier(s)`),
        h('div', {}, ...c.likely.map((e) => chip(e, 'ok')), ...c.other.map((e) => chip(e, 'warn')), ...c.noise.map((e) => chip(e, ''))),
        c.other.length ? h('p', { class: 'hint' }, 'Formats à vérifier (en jaune) : ajoutez-les seulement si ce sont bien des presets.') : null,
        h('div', {}, button('Utiliser ce dossier', () => { addRoot(d.path); for (const e of c.likely) addExtension(e.ext); notify(`Dossier ajouté${c.likely.length ? ` avec ${c.likely.map((e) => '.' + e.ext).join(', ')}` : ' (aucun format de preset reconnu : ajoutez-en un ci-dessous)'}.`, 'ok'); }, true, 'disc-use'), ...otherBtns));
    });
    discoverBox.replaceChildren(hint(`${found.length} dossier(s) trouvé(s). En vert : formats qui ressemblent à des presets ; en jaune : à vérifier ; en gris : bruit (positions de fenêtres, images, journaux…).`),
      button('Tout utiliser (formats probables)', () => { for (const d of found) { addRoot(d.path); for (const e of classifyExts(d.exts).likely) addExtension(e.ext); } notify(`${found.length} dossier(s) ajouté(s) à la liste.`, 'ok'); }, false, 'disc-all'), ...rows);
    notify(`${found.length} dossier(s) de plugins trouvé(s).`, 'ok');
  }, b), true, 'discover');

  const capProject = button('Capturer depuis un projet .carxp', (b) => void run('Capture des sons', async () => {
    const path = await api.pickOpen('Projet Carla', ['carxp']); if (!path) return;
    const stem = path.replace(/^.*[\\/]/, '').replace(/\.carxp$/i, '');
    const rep = captureReport(await api.readTextFile(path), stem, db); const got = rep.states;
    const refus = rep.rejected.length ? ` Refusé : ${rep.rejected.map((r) => `« ${r.plugin.replace(/&apos;/g, "'")} » (${r.problem})`).join(', ')}.` : '';
    if (!got.length) throw new Error(`Ce projet ne contient aucun état de plugin utilisable (plugins non réglés, sans état ou état abîmé).${refus}`);
    const fresh = got.filter((g) => !states.some((s) => s.pluginKey === g.pluginKey && s.chunk === g.chunk));
    states = [...states, ...fresh]; await storeWrite('states', states); rebuildBook();
    notify(`${fresh.length} son(s) capturé(s)${got.length > fresh.length ? ` (${got.length - fresh.length} déjà connu(s))` : ''}.${refus}${statesSizeNote()}`, rep.rejected.length ? 'info' : 'ok');
  }, b), true, 'capture-project');
  const capCurrent = button('Capturer depuis le patchbay actuel', (b) => void run('Capture des sons', async () => {
    const got = captureReport(exportCarxp(project, false), openedStem || 'patchbay', db).states;
    if (!got.length) throw new Error('Aucun plugin du patchbay n\'a d\'état enregistré (ouvrez un projet enregistré par Carla, ou appliquez un son capturé).');
    const fresh = got.filter((g) => !states.some((s) => s.pluginKey === g.pluginKey && s.chunk === g.chunk));
    states = [...states, ...fresh]; await storeWrite('states', states); rebuildBook();
    notify(`${fresh.length} son(s) capturé(s).${statesSizeNote()}`, 'ok');
  }, b), false, 'capture-current');

  render();
  return h('section', { id: 'presets', hidden: true }, h('div', { class: 'grid' },
    card('1. Presets sur le disque',
      hint('Cherche les fichiers de presets de vos plugins (.fxp, .fxb, .vstpreset…). L\'assistant peut alors PROPOSER un preset par plugin ; ces fichiers sont à charger dans le plugin (Carla n\'a pas de moyen de les appliquer automatiquement). Les .fxp/.fxb sont associés à leur plugin par l\'identifiant lu dans le fichier.'),
      h('label', {}, autoChk, ' Appliquer automatiquement les presets Blue Cat\'s (.preset) et TONE3000 (.t3kpreset) (expérimental)'),
      hint('Lit le fichier de preset choisi et écrit l\'état correspondant dans le .carxp, avec la même enveloppe que Carla. TONE3000 (.t3kpreset) : la conversion redonne octet pour octet l\'état enregistré par Carla (vérifié sur un vrai preset). Blue Cat\'s (.preset) : enveloppe vérifiée, contenu du fichier à confirmer. Essayez d\'abord sur UN plugin ; si un plugin ne se charge pas comme prévu dans Carla, décochez. Les presets des autres éditeurs restent à charger à la main.'),
      discover, discoverBox, h('hr'),
      field('Où chercher', modeSel), foldersField, diskField, warn,
      field('Extensions (séparées par des virgules)', extsBox),
      scan, stop, analyse, reset, progress, progressTxt, extBox, subBox),
    card('2. Sons capturés (appliqués automatiquement)',
      hint('Un « son capturé » est l\'état complet d\'un plugin tel que Carla l\'a enregistré dans un projet. Il est réinjecté tel quel dans le .carxp exporté : c\'est le seul moyen sûr d\'appliquer un réglage automatiquement. Réglez le plugin dans Carla, enregistrez le projet, puis capturez-le ici.'),
      capProject, capCurrent, statesBox),
    card('Résultat', summary, field('Plugins ayant des presets', filter), tableBox, unassignedBox)));
}

// ---------------------------------------------------------------------------------------------
// Onglet Plugins

function pluginsSection(): HTMLElement {
  const progressBar = h('div'); const progressTxt = h('div', { class: 'hint' });
  const errorsBox = h('div'); const tableBox = h('div', { class: 'scroll' }); const summary = h('p', { class: 'hint', 'data-id': 'dbsummary' });
  const search = h('input', { type: 'text', placeholder: 'Rechercher un plugin…' });
  const typeSel = h('select', {}, h('option', { value: '' }, 'Tous les types'), h('option', { value: 'VST2' }, 'VST2'), h('option', { value: 'VST3' }, 'VST3'), h('option', { value: 'JSFX' }, 'JSFX'));

  const guessLabel = (p: DbPlugin): string => { const r = rolesOf(p, {}); return r.length ? r.map((x) => ROLE_LABEL[x]).join(' + ') : 'non classé'; };
  const renderTable = (): void => {
    const q = search.value.trim().toLowerCase();
    const rows = db.filter((p) => (!typeSel.value || p.type === typeSel.value) && (!q || p.name.toLowerCase().includes(q) || p.maker.toLowerCase().includes(q)));
    summary.textContent = `${db.length} plugin(s) dans la base${rows.length !== db.length ? `, ${rows.length} affiché(s)` : ''}. Cliquez une ligne pour l'ajouter au Patchbay.`;
    const body = rows.slice(0, 300).map((p) => {
      const key = `${p.path}|${p.name}`;
      const roleSel = h('select', { 'data-id': 'role', title: 'Rôle utilisé par les recettes (corrigez-le si le nom ne suffit pas)' },
        h('option', { value: '' }, `(auto) ${guessLabel(p)}`), ...ROLES.map((r) => h('option', { value: r }, ROLE_LABEL[r])));
      roleSel.value = settings.roleOverrides[key] ?? '';
      roleSel.addEventListener('click', (ev) => ev.stopPropagation());
      roleSel.addEventListener('change', () => { if (roleSel.value) settings.roleOverrides[key] = roleSel.value as Role; else delete settings.roleOverrides[key]; saveSettings(); refreshRoleInfo(); });
      const tr = h('tr', { class: 'click' }, h('td', {}, p.name), h('td', {}, p.type), h('td', {}, p.isSynth ? 'instrument' : 'effet'), h('td', {}, roleSel), h('td', {}, String(p.audioIns)), h('td', {}, String(p.audioOuts)), h('td', {}, p.midiIns ? 'oui' : '—'));
      tr.addEventListener('click', () => { addPlugin(project, p); autoLayout(project); commit(); notify(`« ${p.name} » ajouté au Patchbay.`, 'ok'); });
      return tr;
    });
    tableBox.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ...['Nom', 'Type', 'Genre', 'Rôle (modifiable)', 'Entrées', 'Sorties', 'MIDI'].map((t) => h('th', {}, t)))), h('tbody', {}, ...body)));
    if (rows.length > 300) tableBox.append(hint(`… ${rows.length - 300} autres : affinez la recherche.`));
  };
  search.addEventListener('input', renderTable); typeSel.addEventListener('change', renderTable);
  const setDb = (plugins: DbPlugin[]): void => { db = plugins; saveDb(); renderTable(); rebuildBook(); refreshPatchbayPanel(); };

  const discBox = textBox('discovery', { placeholder: 'C:\\…\\Carla\\carla-discovery-native.exe' }) as HTMLInputElement;
  const findBtn = button('Chercher carla-discovery', (b) => void run('Recherche de carla-discovery', async () => {
    const p = await api.findDiscovery();
    if (!p) throw new Error('Introuvable. Utilisez « Parcourir » : le fichier est dans le dossier de Carla, à côté de Carla.exe.');
    settings.discovery = p; saveSettings(); discBox.value = p; notify(`Trouvé : ${p}`, 'ok');
  }, b));
  const pickBtn = button('Parcourir…', (b) => void run('Choix de carla-discovery', async () => {
    const p = await api.pickOpen('carla-discovery', ['exe']); if (p) { settings.discovery = p; saveSettings(); discBox.value = p; }
  }, b));
  const scanBtn = button('Scanner mes plugins', (b) => void run('Scan des plugins', async () => {
    if (!settings.discovery) throw new Error('Indiquez d\'abord carla-discovery (bouton « Chercher » ou « Parcourir »).');
    const report = await api.scanPlugins(settings.discovery, lines(settings.vst3), lines(settings.vst2), (p) => {
      progressBar.replaceChildren(h('div', { class: 'bar' }, h('div', { style: `width:${Math.round((p.done / Math.max(1, p.total)) * 100)}%` })));
      progressTxt.textContent = `${p.done} / ${p.total} : ${p.current}`;
    });
    const before = db.length;
    const mr = settings.mergeScan ? mergePlugins(db, report.plugins) : null;
    setDb(mr ? mr.merged : report.plugins);
    errorsBox.replaceChildren(report.errors.length
      ? h('details', {}, h('summary', {}, `${report.errors.length} fichier(s) non reconnus comme plugins`), h('ul', { class: 'issues' }, ...report.errors.map((e) => h('li', { class: 'warning' }, `${e.path} : ${e.reason}`))))
      : hint('Aucune erreur.'));
    notify(`${report.plugins.length} plugin(s) trouvés dans ${report.totalFiles} fichier(s).${mr ? ` Base : ${db.length} plugin(s) (${mr.added} ajouté(s), ${mr.updated} mis à jour, ${before} déjà présents conservés).` : ' La base a été remplacée.'}${report.errors.length ? ` ${report.errors.length} fichier(s) non reconnus : détails ci-dessous.` : ''}`, 'ok');
  }, b), true, 'scan');
  const vst3Box = textBox('vst3', { multiline: true }) as HTMLTextAreaElement;
  const vst2Box = textBox('vst2', { multiline: true }) as HTMLTextAreaElement;
  const addLine = (kind: 'vst3' | 'vst2', path: string): void => {
    const cur = lines(settings[kind]);
    if (!cur.includes(path)) settings[kind] = [...cur, path].join('\n');
    (kind === 'vst3' ? vst3Box : vst2Box).value = settings[kind]; saveSettings();
  };
  const addDir3 = button('Ajouter un dossier VST3…', (b) => void run('Choix du dossier', async () => { const p = await api.pickFolder(); if (p) { addLine('vst3', p); notify(`Ajouté à la liste VST3 : ${p}`, 'ok'); } }, b), false, 'add-dir3');
  const addDir2 = button('Ajouter un dossier VST2…', (b) => void run('Choix du dossier', async () => { const p = await api.pickFolder(); if (p) { addLine('vst2', p); notify(`Ajouté à la liste VST2 : ${p}`, 'ok'); } }, b), false, 'add-dir2');
  const addFile = button('Ajouter un plugin précis (fichier)…', (b) => void run('Choix du plugin', async () => {
    const p = await api.pickOpen('Plugin (.vst3 ou .dll)', ['vst3', 'dll']); if (!p) return;
    addLine(/\.vst3$/i.test(p) ? 'vst3' : 'vst2', p); notify(`Plugin ajouté à la liste : ${p}. Cliquez « Scanner mes plugins ».`, 'ok');
  }, b), false, 'add-file');
  const usual = button('Ajouter les emplacements habituels', () => {
    for (const d of ['C:\\Program Files\\Common Files\\VST3', 'C:\\Program Files (x86)\\Common Files\\VST3']) addLine('vst3', d);
    for (const d of ['C:\\Program Files\\VstPlugins', 'C:\\Program Files\\Steinberg\\VstPlugins', 'C:\\Program Files (x86)\\VstPlugins', 'C:\\Program Files (x86)\\Steinberg\\VstPlugins', 'C:\\Program Files\\Common Files\\VST2', 'C:\\Program Files\\Common Files\\Steinberg\\VST2']) addLine('vst2', d);
    notify('Emplacements habituels ajoutés (les dossiers qui n\'existent pas sont simplement ignorés).', 'ok');
  }, false, 'usual-dirs');
  const mergeChk = h('input', { type: 'checkbox', checked: settings.mergeScan, 'data-id': 'merge-scan' });
  mergeChk.addEventListener('change', () => { settings.mergeScan = mergeChk.checked; saveSettings(); });
  let armed = false;
  const clearDb = button('Vider la base', (b) => {
    if (!armed) { armed = true; b.textContent = 'Confirmer : vider la base'; setTimeout(() => { armed = false; b.textContent = 'Vider la base'; }, 5000); return; }
    armed = false; b.textContent = 'Vider la base'; setDb([]); notify('Base vidée (vos plugins ne sont pas désinstallés : relancez un scan).', 'info');
  }, false, 'clear-db');
  const importBtn = button('Importer plugins_db.json', (b) => void run('Import de la base', async () => {
    const p = await api.pickOpen('Base de plugins', ['json']); if (!p) return;
    const data = JSON.parse(await api.readTextFile(p)) as unknown;
    const arr = Array.isArray(data) ? data : (data as { plugins?: unknown }).plugins;
    if (!Array.isArray(arr)) throw new Error('Ce fichier ne contient pas de liste de plugins.');
    const ok = arr.map(normalizePlugin).filter((x): x is DbPlugin => x !== null);
    setDb(ok); notify(`${ok.length} plugin(s) importés${ok.length < arr.length ? `, ${arr.length - ok.length} ignorés (format invalide)` : ''}.`, 'ok');
  }, b));
  const exportBtn = button('Exporter la base', (b) => void run('Export de la base', async () => {
    if (!db.length) throw new Error('La base est vide.');
    const p = await api.pickSave('plugins_db.json', 'Base de plugins', ['json']); if (!p) return;
    await api.writeTextFile(p, JSON.stringify({ format: 'carla-patchbay-plugins-db', version: 1, count: db.length, plugins: db }, null, 2));
    notify(`Base enregistrée : ${p}`, 'ok');
  }, b));

  renderTable();
  return h('section', { id: 'plugins', hidden: true }, h('div', { class: 'grid' },
    card('Scanner ma bibliothèque',
      hint('L\'assistant ne propose que des plugins de cette base. Le scan utilise l\'outil de Carla (carla-discovery) : ports audio et MIDI et identifiants exacts ; les plugins 32 bits sont essayés avec carla-discovery-win32.exe.'),
      field('carla-discovery', discBox), findBtn, pickBtn,
      field('Dossiers VST3 (un par ligne : un dossier est parcouru avec ses sous-dossiers ; un plugin précis peut aussi être écrit ici)', vst3Box),
      field('Dossiers VST2 (un par ligne)', vst2Box),
      h('div', { class: 'toolbar' }, addDir3, addDir2, addFile, usual),
      h('label', {}, mergeChk, ' Ajouter à ma base (ne rien effacer) : recommandé, car un scan partiel ne vide plus les autres plugins'),
      scanBtn, progressBar, progressTxt, errorsBox),
    card('Ma base de plugins', summary, h('div', { class: 'row' }, search, typeSel), tableBox, importBtn, exportBtn, clearDb)));
}

// ---------------------------------------------------------------------------------------------
// Onglet Aide

function helpSection(): HTMLElement {
  return h('section', { id: 'aide', hidden: true }, h('div', { class: 'grid' },
    card('À quoi sert cet outil', hint('C\'est un outil de PRÉPARATION : il construit le câblage du patchbay de Carla dans un fichier .carxp que vous ouvrez ensuite dans Carla. Il ne démarre pas le moteur audio et ne touche pas à votre carte son.')),
    card('Démarrage en 5 étapes', h('ol', { class: 'steps' },
      h('li', {}, 'Plugins : « Chercher carla-discovery » (dossier de Carla, à côté de Carla.exe) puis « Scanner mes plugins ».'),
      h('li', {}, 'Assistant : choisissez votre fournisseur d\'IA et collez votre clé API ; vérifiez les noms de ports de votre carte son.'),
      h('li', {}, 'Décrivez ce que vous voulez jouer et cliquez « Créer la chaîne avec l\'IA ».'),
      h('li', {}, 'Patchbay : regardez la chaîne, corrigez à la souris (câbles, boîtes, plugin contourné).'),
      h('li', {}, '« Enregistrer en .carxp » puis « Ouvrir dans Carla ».'))),
    card('Clés API et quotas', h('ul', { class: 'steps' },
      h('li', {}, 'Un abonnement Claude (Pro/Max) ne donne PAS de clé API : il faut un compte Console (console.anthropic.com) avec des crédits prépayés, puis Settings → API Keys → Create key. Cette clé n\'est liée à aucun abonnement : l\'arrêt de votre abonnement ne la touche pas.'),
      h('li', {}, 'Gemini : clé gratuite sur aistudio.google.com/apikey (niveau gratuit avec limites de requêtes par minute et par jour, qui peuvent changer). ChatGPT : clé sur platform.openai.com, avec crédits.'),
      h('li', {}, 'Chaque fournisseur garde sa clé et son modèle. Si la limite PAR MINUTE est atteinte, l\'application attend et réessaie toute seule (2 fois au plus). Si le quota du JOUR est épuisé, elle bascule sur le « fournisseur de secours » s\'il a une clé ; sinon elle l\'indique.'),
      h('li', {}, 'Une demande = 1 à 3 appels (l\'IA peut devoir corriger une erreur de câblage). Le compteur « Appels envoyés aujourd\'hui » compte ce que CETTE application envoie ; il ne connaît pas votre quota réel.'),
      h('li', {}, 'Si Gemini refuse souvent, essayez un autre modèle dans le champ « Modèle » (certains ont des limites plus larges) ou mettez un fournisseur de secours.'))),
    card('Ollama : une IA gratuite sur votre PC', h('ul', { class: 'steps' },
      h('li', {}, 'Installez Ollama (ollama.com/download/windows), lancez-le, puis dans un terminal : « ollama pull qwen2.5:7b » (ou un autre modèle). Choisissez « Ollama » dans les réglages de l\'IA : aucune clé, aucun quota, rien ne sort de votre ordinateur.'),
      h('li', {}, 'Le logiciel et les modèles ouverts sont gratuits, mais c\'est votre PC qui calcule : il faut de la mémoire (la taille du modèle téléchargé, environ) et la réponse est plus lente. Vérifiez la licence du modèle choisi.'),
      h('li', {}, 'Trop lent ? Le temps vient surtout de la lecture de la liste de vos plugins par le modèle. Baissez « Plugins envoyés au modèle » (ex. 60) : l\'application garde les plus pertinents pour votre demande. Un modèle plus petit (ex. qwen2.5:3b ou llama3.2:3b) est plus rapide mais plus brouillon. Pour savoir si Ollama travaille : dans un terminal, « ollama ps » (colonne PROCESSOR : CPU ou GPU) et le Gestionnaire des tâches.'),
      h('li', {}, 'Un petit modèle local se trompe plus souvent qu\'un grand modèle en ligne : le programme vérifie tout et renvoie les erreurs au modèle (3 essais), mais vous aurez plus d\'échecs. Avec peu de mémoire, l\'application n\'envoie que les plugins les plus pertinents pour votre demande.'),
      h('li', {}, 'Ollama peut aussi servir de « fournisseur de secours » quand un quota en ligne est atteint.'))),
    card('Stratégie sans frais', h('ul', { class: 'steps' },
      h('li', {}, '1) Plugins : scannez TOUS vos dossiers (un scan AJOUTE à la base, il n\'efface plus rien). Un plugin manquant ? « Ajouter un plugin précis » ou « Ajouter un dossier ». Les plugins en dossier .vst3 (comme TONE3000) sont lus par leur fichier intérieur, comme dans Carla.'),
      h('li', {}, '2) Corrigez au besoin le « Rôle » de chaque plugin (ampli, compresseur, réverbération…) : les recettes s\'en servent.'),
      h('li', {}, '3) Assistant → « Recettes de sons » : choisissez un son (Jazz, Reggae, Funk, Clapton, Santana, Police…) et cliquez « Construire ». Sans IA, sans clé, sans quota, sans erreur de syntaxe.'),
      h('li', {}, '4) Les presets et sons capturés de vos plugins sont ajoutés automatiquement quand ils correspondent à la recette (onglet Presets).'),
      h('li', {}, '5) L\'IA (Gemini gratuit ou Ollama) reste facultative ; si elle échoue, l\'appli vous propose la recette la plus proche.'))),
    card('Presets', h('ul', { class: 'steps' },
      h('li', {}, 'Onglet Presets → « Découvrir automatiquement » cherche, pour chacun de vos plugins, les dossiers qui lui correspondent (AppData, ProgramData, Documents, dossiers VST) et liste les formats trouvés (probables presets / à vérifier / bruit). Utile pour les plugins dont vous ne connaissez pas le format, par exemple MeldaProduction, qui range ses réglages dans AppData\\Roaming\\MeldaProduction avec aussi des fichiers qui ne sont pas des presets (.winstate = positions de fenêtres).'),
      h('li', {}, 'Onglet Presets → « Scanner les presets » : dossiers précis (recommandé) ou disque entier (long, arrêtable). Les fichiers .fxp/.fxb sont reconnus par l\'identifiant du plugin lu dans le fichier ; les autres par le nom de leur dossier. « Analyser un dossier » liste les extensions qu\'il contient pour découvrir le format d\'un plugin.'),
      h('li', {}, 'L\'assistant peut PROPOSER un preset par plugin (liste vérifiée : un preset inventé ou d\'un autre plugin est refusé). Un preset FICHIER est affiché et noté dans la fiche : vous le chargez dans le plugin. Un SON CAPTURÉ (état d\'un plugin lu dans un projet Carla) est appliqué automatiquement dans le .carxp.'),
      h('li', {}, 'Dans le Patchbay, sélectionnez un plugin pour choisir ou retirer son preset à la main.'))),
    card('Patchbay : outils', h('ul', { class: 'steps' },
      h('li', {}, 'Câbles : appuyez sur un port et glissez jusqu\'à un autre port (les ports incompatibles s\'estompent), ou cliquez deux ports. Double-clic sur un câble = le supprimer.'),
      h('li', {}, 'Sélection : en-tête d\'une boîte, Maj+clic pour en ajouter, cadre tiré sur le fond, Ctrl+A. Les boîtes sélectionnées se déplacent ensemble ; Suppr les efface.'),
      h('li', {}, 'Couleur : cliquez le point en haut à gauche d\'une boîte pour choisir la couleur de son cadre (8 couleurs ou une couleur libre) ; « Couleurs par rôle » colore toute la chaîne d\'un coup. La couleur est propre à cet outil : Carla ne la garde pas.'),
      h('li', {}, 'Panneau Sélection : couleur, alignement, répartition, aimantation, preset. Zoom − / + (ou Ctrl+molette), « Centrer la vue ».'),
      h('li', {}, '« Centrer dans Carla à l\'enregistrement » : toutes les boîtes (plugins ET carte son) sont positionnées au milieu du canevas de Carla, avec la disposition que vous avez dessinée.'))),
    card('Reprendre un projet existant', h('ul', { class: 'steps' },
      h('li', {}, 'Patchbay → « Ouvrir un .carxp » : le projet s\'affiche avec ses plugins et son câblage. Vos réglages de plugins sont conservés à l\'enregistrement (seul le câblage change), ainsi que le reste du fichier.'),
      h('li', {}, 'Assistant → cochez « Modifier la chaîne actuelle » pour demander une amélioration (« ajoute un limiteur », « rends-la plus propre ») sans refaire toute la chaîne. Les plugins du projet doivent être dans votre base.'),
      h('li', {}, 'Scènes : enregistrez plusieurs états du même rig (plugins contournés, câblage) et exportez-les en fichiers .carxp séparés ; l\'IA peut proposer des variantes. ⇄ remplace un plugin en gardant les câbles compatibles (les réglages sauvegardés de l\'ancien plugin ne sont pas transférés).'),
      h('li', {}, 'Annuler / Rétablir : boutons ou Ctrl+Z / Ctrl+Y. Mes chaînes : gardez vos patchbays d\'un concert à l\'autre. « Vérifier les plugins » signale un fichier déplacé ou désinstallé avant le concert. « Fiche (.md) » : un aide-mémoire à garder sous la main.'))),
    card('Ce qui est vérifié, et ce qui ne l\'est pas', h('ul', { class: 'steps' },
      h('li', {}, 'Le programme vérifie TOUT ce que propose l\'IA : plugin réellement présent dans votre base, ports existants, câbles audio/MIDI compatibles, chemin jusqu\'à la sortie. En cas de faute, l\'IA reçoit la liste précise des erreurs et corrige (3 essais maximum).'),
      h('li', {}, 'Ce que le programme ne peut PAS juger : la qualité sonore réelle. Les conseils de réglage de l\'IA sont des suggestions à écouter et à ajuster.'),
      h('li', {}, 'À valider chez vous : le scan avec votre vrai carla-discovery, la réponse de votre fournisseur d\'IA (nom du modèle, quota), et l\'ouverture du .carxp généré dans votre Carla.'),
      h('li', {}, 'Un type de plugin JSFX n\'est pas vérifié dans le format .carxp : testez l\'ouverture.')))));
}

// ---------------------------------------------------------------------------------------------
// Assemblage

function mount(): void {
  const root = document.getElementById('root');
  if (!root) return;
  statusEl = h('div', { id: 'status', class: 'info' }, 'Prêt.');
  const tabs: Array<[string, string, HTMLElement]> = [
    ['assistant', 'Assistant', assistantSection()], ['patchbay', 'Patchbay', patchbaySection()], ['chaines', 'Mes chaînes', chainsSection()],
    ['presets', 'Presets', presetsSection()], ['plugins', 'Plugins', pluginsSection()], ['aide', 'Aide', helpSection()],
  ];
  const nav = h('nav');
  showTab = (id: string): void => {
    for (const [tid, , el] of tabs) el.hidden = tid !== id;
    for (const b of Array.from(nav.children)) (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.tab === id);
    if (id === 'patchbay') { refreshPatchbayPanel(); view?.render(); }
  };
  for (const [id, label] of tabs) nav.append(h('button', { 'data-tab': id }, label));
  document.addEventListener('keydown', (ev) => {
    const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement;
    if (typing || !(ev.ctrlKey || ev.metaKey) || document.getElementById('patchbay')?.hidden !== false) return;
    const k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); } else if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); redo(); }
  });
  nav.addEventListener('click', (e) => { const t = (e.target as HTMLElement).dataset.tab; if (t) showTab(t); });
  root.replaceChildren(h('div', { class: 'app' },
    h('header', {}, h('h1', {}, 'CARLA WIRING'), h('span', { class: 'sub' }, 'préparation du patchbay de Carla'), nav),
    h('main', {}, ...tabs.map((t) => t[2])), statusEl));
  showTab('assistant');
  void loadStores();
}

mount();
