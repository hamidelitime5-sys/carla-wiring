// src/lib/chain.ts : l'assistant IA qui construit une chaîne complète à partir de VOTRE base de plugins.
//
// Principe de fiabilité : l'IA ne fait que PROPOSER. Son JSON est vérifié par le code (plugins réellement
// présents dans la base, ports existants, types de câbles compatibles, chemin jusqu'à la sortie). En cas
// d'erreur, elle reçoit la liste précise des fautes et corrige (3 essais maximum). Rien n'est affiché comme
// « réussi » sans avoir passé cette validation.
import { nodePorts, validateProject, type DbPlugin, type HardwareProfile, type PatchCable, type PatchNode, type PatchProject } from './carxp';
import { autoLayout, fanOutMono, HW_NAMES, type HwKind } from './editor';
import { applyPreset, type PresetBook, type PresetCandidate } from './presets';

export const MAX_ATTEMPTS = 3;
const RESERVED: Record<string, HwKind> = { in: 'hw-in', out: 'hw-out', midi: 'midi-in' };

export interface ResolvedPreset { id: string; pluginId: string; cand: PresetCandidate }

export interface Catalog {
  text: string;
  byId: Map<string, DbPlugin>;
  total: number;
  shown: number;
  presets?: Map<string, ResolvedPreset>; // presets proposables à l'IA (identifiants s1, s2…)
  presetText?: string;
}

/**
 * Prépare la liste des presets proposés à l'IA : pour chaque plugin du catalogue qui en a, les plus pertinents pour
 * la demande (au plus `perPlugin`), dans la limite de `maxLines` plugins. Les identifiants (s1, s2…) sont propres à cette demande.
 */
export function buildPresetTable(cat: Catalog, book: PresetBook, request: string, maxLines = 120, perPlugin = 8): number {
  const map = new Map<string, ResolvedPreset>();
  const lines: string[] = [];
  let n = 0;
  for (const [pid, plugin] of cat.byId) {
    if (lines.length >= maxLines) break;
    const cands = book.forPlugin(plugin, request, perPlugin);
    if (!cands.length) continue;
    const parts = cands.map((c) => { n++; const id = `s${n}`; map.set(id, { id, pluginId: pid, cand: c }); return `${id} « ${c.name} »${c.collection ? ` [${c.collection}]` : ''}${c.kind === 'state' ? ' [son capturé]' : ''}`; });
    lines.push(`${pid} (${plugin.name}) : ${parts.join(' ; ')}`);
  }
  cat.presets = map;
  cat.presetText = lines.join('\n');
  return n;
}

export function buildCatalog(db: DbPlugin[], max = 600): Catalog {
  const list = db.slice(0, max);
  const byId = new Map<string, DbPlugin>();
  const lines = list.map((p, i) => {
    const id = `p${i + 1}`;
    byId.set(id, p);
    const kind = p.isSynth ? 'instrument' : 'effet';
    const maker = p.maker ? ` | ${p.maker.slice(0, 24)}` : '';
    return `${id} | ${p.name} | ${p.type}${maker} | ${kind} | in:${p.audioIns} out:${p.audioOuts} midi:${p.midiIns ? 'oui' : 'non'}`;
  });
  return { text: lines.join('\n'), byId, total: db.length, shown: list.length };
}

// Mots de la demande → noms de plugins probablement utiles (sélection quand le catalogue est trop gros).
const KEYWORD_PAIRS: Array<[RegExp, RegExp]> = [
  [/compress|dynamique|sustain|nivel/i, /comp|1176|la-?2a|opto|level/i],
  [/\beq\b|égalis|egalis|equal|correctif|timbre/i, /\beq\b|equal|egal|pultec|pro-q|channel/i],
  [/limit|sécurité|securite|crête|crete/i, /limit|maxim|clip|l[12]\b/i],
  [/réverb|reverb|espace|salle|plate/i, /reverb|verb|room|hall|plate|space/i],
  [/delay|écho|echo/i, /delay|echo/i],
  [/guitar|ampli|satur|lead|distors|basse/i, /amp|rig|guitar|bass|cab|dist|drive|overdrive|fuzz|tube/i],
  [/piano|clavier|keys|nappe|orgue|rhodes/i, /piano|keys|rhodes|organ|pad|string|synth|kontakt|omnisphere|nord|korg/i],
  [/batterie|drum|percu/i, /drum|kit|beat|superior|addictive/i],
  [/ketron|arrang|accompagn/i, /ketron|arrang|style/i],
  [/mixeur|mixer|mélang|melang|console|mixage|bus/i, /mix|console|bus|sum/i],
  [/compteur|meter|niveau|analy/i, /meter|analy|spectrum|vu|loud|scope/i],
  [/gate|bruit|souffle/i, /gate|expand|denois|noise/i],
];
const ESSENTIAL = /limit|compress|\beq\b|equal|reverb|meter|mixer|console/i;

/**
 * Quand la base dépasse la taille de catalogue acceptable (petit modèle local, jetons limités), garde les plugins
 * les plus pertinents pour la demande (mots de la demande, outils essentiels, plugins déjà utilisés), dans l'ordre d'origine.
 */
export function selectForRequest(db: DbPlugin[], request: string, max: number, keep: DbPlugin[] = []): DbPlugin[] {
  if (db.length <= max) return db;
  const words = request.toLowerCase().split(/[^a-z0-9àâäéèêëîïôöùûüç]+/).filter((w) => w.length >= 4);
  const keepKeys = new Set(keep.map((k) => `${k.path}|${k.name}`));
  const scored = db.map((p, i) => {
    const n = p.name.toLowerCase();
    let s = 0;
    if (keepKeys.has(`${p.path}|${p.name}`)) s += 1000;
    if (words.some((w) => n.includes(w))) s += 6;
    for (const [asked, useful] of KEYWORD_PAIRS) if (asked.test(request) && useful.test(p.name)) s += 4;
    if (ESSENTIAL.test(p.name)) s += 2;
    return { p, i, s };
  });
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, Math.max(1, max)).sort((a, b) => a.i - b.i).map((x) => x.p);
}

export function systemPrompt(): string {
  return [
    'Tu es un ingénieur du son spécialisé dans le LIVE et dans l\'hôte de plugins Carla (patchbay).',
    'Tu construis des chaînes de plugins complètes, bien câblées, pour obtenir le meilleur son possible sur scène,',
    'en utilisant UNIQUEMENT les plugins du catalogue fourni (jamais un plugin inventé ou absent du catalogue).',
    '',
    'Règles de métier (live) :',
    '- Latence faible : évite les plugins à anticipation (look-ahead) ou à phase linéaire sauf besoin justifié.',
    '- Ordre logique du signal et gain staging (niveaux propres, pas de saturation involontaire).',
    '- Termine la chaîne par un limiteur de sécurité si le catalogue en contient un.',
    '- Un instrument virtuel reçoit du MIDI (events-in) ; un effet reçoit de l\'audio (input_N).',
    '- Reste raisonnable sur le CPU : pas de plugins redondants.',
    '- Si le catalogue ne contient pas ce qu\'il faudrait, dis-le dans "missing" et fais au mieux avec ce qui existe.',
    '',
    'Format de réponse : UNIQUEMENT un objet JSON, sans texte autour, de cette forme :',
    '{',
    '  "name": "nom court de la chaîne",',
    '  "summary": "2 à 3 phrases : l\'idée sonore et pourquoi ces choix",',
    '  "notes": ["conseils de réglage / de gain / de live"],',
    '  "missing": ["ce qui manque dans le catalogue, sinon liste vide"],',
    '  "nodes": [ { "id": "n1", "plugin": "p12", "role": "ampli", "why": "pourquoi celui-ci", "preset": "s3" } ],',
    '  "cables": [ { "from": "in:capture_1", "to": "n1:input_1" }, { "from": "n1:output_1", "to": "out:playback_1" } ]',
    '}',
    '',
    'Règles de câblage :',
    '- "plugin" est l\'identifiant du catalogue (p1, p2…). Un plugin peut servir plusieurs fois (avec des "id" de nœud différents).',
    '- Ports d\'un plugin : input_1…input_N (entrées audio), output_1…output_M (sorties audio), events-in (entrée MIDI) et events-out (sortie MIDI) quand le catalogue indique midi:oui.',
    '- Nœuds de la carte son : "in" (sorties = les entrées de la carte), "out" (entrées = les sorties de la carte), "midi" (ports MIDI). Leurs noms de ports exacts sont donnés dans la demande.',
    '- Un câble relie une SORTIE à une ENTRÉE du même type (audio vers audio, MIDI vers MIDI), sous la forme "idNœud:port".',
    '- Une chaîne stéréo relie output_1 vers input_1 ET output_2 vers input_2 ; un plugin mono (une seule entrée) ne reçoit que input_1.',
    '- Le signal doit arriver jusqu\'au nœud "out".',
    '- Un plugin qui n\'a qu\'UNE sortie audio (mono) : relie cette sortie aux DEUX entrées de sa destination (ex. playback_1 ET playback_2), sinon le son ne sort que d\'un côté.',
    '- Presets (facultatif) : si une liste PRESETS DISPONIBLES est fournie, ajoute "preset": "sN" à un nœud dont le plugin y figure, pour proposer un réglage adapté à la demande. N\'invente JAMAIS de preset et n\'utilise que ceux du plugin du nœud ; omets le champ si aucun ne convient. Un « [son capturé] » est appliqué automatiquement ; les autres sont des fichiers que l\'utilisateur chargera dans le plugin.',
    '- Plusieurs instruments ou sources (guitare, clavier, Ketron…) peuvent coexister : chaque source a sa propre sous-chaîne ; plusieurs sorties peuvent être reliées à la MÊME entrée (Carla les additionne), ou passer par un plugin mixeur du catalogue. Relie chaque instrument au bon port MIDI de la carte selon la demande.',
    '',
    'Si une CHAÎNE ACTUELLE est fournie : c\'est une modification. Garde les nœuds qui conviennent (mêmes identifiants), change le minimum nécessaire pour répondre à la demande, et renvoie la chaîne COMPLÈTE modifiée dans le même format.',
  ].join('\n');
}

export function userPrompt(request: string, cat: Catalog, hw: HardwareProfile, current?: string): string {
  return [
    current ? `MODIFICATION DEMANDÉE : ${request.trim()}` : `DEMANDE : ${request.trim()}`,
    ...(current ? ['', 'CHAÎNE ACTUELLE (JSON) :', current] : []),
    '',
    'CARTE SON (noms de ports exacts) :',
    `- "in" (entrées) : ${hw.audioIn.join(', ') || '(aucune)'}`,
    `- "out" (sorties) : ${hw.audioOut.join(', ') || '(aucune)'}`,
    `- "midi" (entrées MIDI) : ${hw.midiIn.join(', ') || '(aucune)'}`,
    '',
    `CATALOGUE (${cat.shown} plugin(s)${cat.total > cat.shown ? ` sur ${cat.total}, liste tronquée` : ''}) — id | nom | format | fabricant | rôle | ports :`,
    cat.text,
    ...(cat.presetText ? ['', 'PRESETS DISPONIBLES (plugin : id « nom ») — facultatif :', cat.presetText] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------

export interface AiChain {
  name: string;
  summary: string;
  notes: string[];
  missing: string[];
  nodes: Array<{ id: string; plugin: string; role?: string; why?: string; preset?: string }>;
  cables: Array<{ from: string; to: string }>;
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence && fence[1]) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('La réponse ne contient aucun objet JSON.');
  return JSON.parse(t.slice(a, b + 1));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseChain(text: string): AiChain {
  let raw: unknown;
  try { raw = extractJson(text); } catch (e) { throw new Error(`JSON illisible : ${e instanceof Error ? e.message : String(e)}`); }
  if (typeof raw !== 'object' || raw === null) throw new Error('La réponse n\'est pas un objet JSON.');
  const o = raw as Record<string, unknown>;
  const nodes = Array.isArray(o.nodes) ? o.nodes : [];
  const cables = Array.isArray(o.cables) ? o.cables : [];
  return {
    name: str(o.name) || 'Chaîne sans nom',
    summary: str(o.summary),
    notes: strList(o.notes),
    missing: strList(o.missing),
    nodes: nodes.map((n) => {
      const x = (n ?? {}) as Record<string, unknown>;
      return { id: str(x.id), plugin: str(x.plugin), role: str(x.role) || undefined, why: str(x.why) || undefined, preset: str(x.preset) || undefined };
    }),
    cables: cables.map((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      return { from: str(x.from), to: str(x.to) };
    }),
  };
}

export interface ChainResult {
  project: PatchProject;
  errors: string[];
  warnings: string[];
}

function splitRef(ref: string): { node: string; port: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  return { node: ref.slice(0, i).trim(), port: ref.slice(i + 1).trim() };
}

/** Vérifie la proposition de l'IA et la transforme en patchbay. `errors` vide = utilisable. */
export function chainToProject(ai: AiChain, cat: Catalog, hw: HardwareProfile): ChainResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const project: PatchProject = { nodes: [], cables: [], hardware: hw };
  if (ai.nodes.length === 0) errors.push('Aucun nœud dans la chaîne.');

  const idToNode = new Map<string, PatchNode>();
  const seen = new Set<string>();
  for (const n of ai.nodes) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(n.id)) { errors.push(`Identifiant de nœud invalide : « ${n.id} ».`); continue; }
    if (n.id in RESERVED) { errors.push(`L'identifiant « ${n.id} » est réservé à la carte son : utilisez n1, n2…`); continue; }
    if (seen.has(n.id)) { errors.push(`Identifiant de nœud en double : « ${n.id} ».`); continue; }
    seen.add(n.id);
    const plugin = cat.byId.get(n.plugin);
    if (!plugin) { errors.push(`Le nœud « ${n.id} » utilise « ${n.plugin} », qui n'est pas dans le catalogue : choisissez uniquement parmi les identifiants fournis (de p1 à p${cat.byId.size}).`); continue; }
    const base = plugin.name;
    const same = [...idToNode.values()].filter((x) => x.plugin?.path === plugin.path && x.plugin?.name === plugin.name).length;
    const node: PatchNode = { id: n.id, kind: 'plugin', name: same ? `${base} ${same + 1}` : base, plugin, x: 0, y: 0 };
    idToNode.set(n.id, node);
    project.nodes.push(node);
    if (n.preset) {
      const pr = cat.presets?.get(n.preset);
      if (!pr) errors.push(`Le preset « ${n.preset} » du nœud « ${n.id} » n'existe pas dans la liste PRESETS DISPONIBLES : n'invente pas de preset, omets le champ.`);
      else if (pr.pluginId !== n.plugin) errors.push(`Le preset « ${n.preset} » appartient au plugin ${pr.pluginId}, pas à ${n.plugin} (nœud « ${n.id} ») : utilise uniquement les presets du plugin du nœud.`);
      else applyPreset(node, pr.cand);
    }
  }

  const hwNode = (id: string): PatchNode | undefined => {
    const kind = RESERVED[id];
    if (!kind) return undefined;
    let node = idToNode.get(id);
    if (!node) {
      node = { id, kind, name: HW_NAMES[kind], x: 0, y: 0 };
      idToNode.set(id, node);
      project.nodes.push(node);
    }
    return node;
  };

  const cableKeys = new Set<string>();
  for (const c of ai.cables) {
    const a = splitRef(c.from);
    const b = splitRef(c.to);
    if (!a || !b) { errors.push(`Câble mal écrit : « ${c.from} » → « ${c.to} » (format attendu « idNœud:port »).`); continue; }
    const na = idToNode.get(a.node) ?? hwNode(a.node);
    const nb = idToNode.get(b.node) ?? hwNode(b.node);
    if (!na) { errors.push(`Câble « ${c.from} » → « ${c.to} » : le nœud « ${a.node} » n'existe pas.`); continue; }
    if (!nb) { errors.push(`Câble « ${c.from} » → « ${c.to} » : le nœud « ${b.node} » n'existe pas.`); continue; }
    const pa = nodePorts(na, hw).outputs;
    const pb = nodePorts(nb, hw).inputs;
    const out = pa.find((p) => p.name === a.port);
    const inp = pb.find((p) => p.name === b.port);
    if (!out) { errors.push(`« ${c.from} » : « ${a.port} » n'est pas une SORTIE de « ${na.name} » (sorties : ${pa.map((p) => p.name).slice(0, 8).join(', ') || 'aucune'}).`); continue; }
    if (!inp) { errors.push(`« ${c.to} » : « ${b.port} » n'est pas une ENTRÉE de « ${nb.name} » (entrées : ${pb.map((p) => p.name).slice(0, 8).join(', ') || 'aucune'}).`); continue; }
    if (out.type !== inp.type) { errors.push(`Câble interdit « ${c.from} » → « ${c.to} » : ${out.type} vers ${inp.type}.`); continue; }
    const key = `${na.id}|${a.port}|${nb.id}|${b.port}`;
    if (cableKeys.has(key)) { warnings.push(`Câble en double ignoré : ${c.from} → ${c.to}.`); continue; }
    cableKeys.add(key);
    const cable: PatchCable = { fromNode: na.id, fromPort: a.port, toNode: nb.id, toPort: b.port };
    project.cables.push(cable);
  }

  // le signal doit atteindre la sortie de la carte
  const out = project.nodes.find((n) => n.kind === 'hw-out');
  if (!out || !project.cables.some((c) => c.toNode === out.id)) {
    errors.push('Aucun câble n\'arrive à la sortie de la carte son (« out »).');
  } else {
    const reach = new Set<string>([out.id]);
    for (let pass = 0; pass < project.nodes.length; pass++) {
      for (const c of project.cables) if (reach.has(c.toNode)) reach.add(c.fromNode);
    }
    for (const n of project.nodes.filter((x) => x.kind === 'plugin')) {
      if (!reach.has(n.id)) warnings.push(`« ${n.name} » n'arrive pas jusqu'à la sortie : il ne sert à rien dans cette chaîne.`);
    }
  }
  for (const n of project.nodes.filter((x) => x.kind === 'plugin' && x.plugin)) {
    const p = n.plugin as DbPlugin;
    if (p.midiIns > 0 && p.isSynth && !project.cables.some((c) => c.toNode === n.id && c.toPort === 'events-in')) {
      warnings.push(`L'instrument « ${n.name} » ne reçoit pas de MIDI (events-in non relié).`);
    }
  }
  for (const i of validateProject(project, { requirePluginFiles: true })) {
    if (i.level === 'error') errors.push(i.message);
    else if (!/relié à rien/.test(i.message) || project.nodes.length > 0) warnings.push(i.message);
  }
  // dédoublonne les avertissements
  const uniq = (l: string[]): string[] => [...new Set(l)];
  autoLayout(project);
  project.meta = { name: ai.name, summary: ai.summary, notes: ai.notes, missing: ai.missing };
  return { project, errors: uniq(errors), warnings: uniq(warnings) };
}

// ---------------------------------------------------------------------------------------------
// Modifier une chaîne existante

const HW_REF: Record<string, string> = { 'hw-in': 'in', 'hw-out': 'out', 'midi-in': 'midi' };
const keyOf = (p: DbPlugin): string => `${p.path}|${p.name}`;

/** Décrit le patchbay actuel dans le format de l'IA. `unknown` = plugins du projet absents du catalogue. */
export function describeProject(project: PatchProject, cat: Catalog): { json: string; unknown: string[] } {
  const idByKey = new Map<string, string>();
  for (const [id, p] of cat.byId) if (!idByKey.has(keyOf(p))) idByKey.set(keyOf(p), id);
  const ref = new Map<string, string>();
  const unknown: string[] = [];
  const nodes: Array<{ id: string; plugin: string; role: string }> = [];
  let i = 0;
  for (const n of project.nodes) {
    if (n.kind !== 'plugin' || !n.plugin) { ref.set(n.id, HW_REF[n.kind] ?? n.id); continue; }
    i++;
    ref.set(n.id, `n${i}`);
    const catId = idByKey.get(keyOf(n.plugin));
    if (!catId) { unknown.push(n.name); continue; }
    nodes.push({ id: `n${i}`, plugin: catId, role: n.name });
  }
  const cables = project.cables.map((c) => ({ from: `${ref.get(c.fromNode) ?? c.fromNode}:${c.fromPort}`, to: `${ref.get(c.toNode) ?? c.toNode}:${c.toPort}` }));
  return { json: JSON.stringify({ nodes, cables }, null, 1), unknown };
}

/**
 * Après une modification par l'IA : les plugins conservés reprennent leurs réglages d'origine (bloc du fichier,
 * état sauvegardé, contournement) et le projet garde son en-tête et sa fin de fichier.
 */
export function inheritFrom(next: PatchProject, prev: PatchProject): void {
  const used = new Set<string>();
  const inherited = new Set<string>();
  for (const n of next.nodes) {
    if (n.kind !== 'plugin' || !n.plugin) continue;
    const plugin = n.plugin;
    const old = prev.nodes.find((o) => o.kind === 'plugin' && o.plugin && !used.has(o.id) && o.plugin.path === plugin.path && o.plugin.name === plugin.name);
    if (!old) continue;
    used.add(old.id); inherited.add(n.id);
    n.name = old.name; n.bypass = old.bypass;
    // un « son capturé » choisi par l'IA remplace l'ancien état ; sinon le plugin garde ses réglages d'origine
    if (n.preset?.kind !== 'state') { n.raw = old.raw; n.chunk = old.chunk; if (!n.preset && old.preset) n.preset = old.preset; }
  }
  const taken = new Set(next.nodes.filter((n) => inherited.has(n.id)).map((n) => n.name.toLowerCase()));
  for (const n of next.nodes) {
    if (n.kind !== 'plugin' || inherited.has(n.id)) continue;
    let name = n.name; let k = 2;
    while (taken.has(name.toLowerCase())) name = `${n.name} ${k++}`;
    n.name = name; taken.add(name.toLowerCase());
  }
  next.base = prev.base;
}

// ---------------------------------------------------------------------------------------------
// Boucle : demande à l'IA, valide, renvoie les fautes à l'IA, recommence (3 essais)

export interface ChatMsg { role: 'user' | 'assistant'; content: string }
export type AskFn = (system: string, messages: ChatMsg[]) => Promise<string>;

export interface GenerateOutcome {
  ok: boolean;
  attempts: number;
  chain?: AiChain;
  result?: ChainResult;
  error?: string;
}

export async function generateChain(
  ask: AskFn, request: string, db: DbPlugin[], hw: HardwareProfile, log: (line: string) => void, current?: PatchProject, opts?: { maxCatalog?: number; presets?: PresetBook; maxPresetLines?: number },
): Promise<GenerateOutcome> {
  if (!request.trim()) return { ok: false, attempts: 0, error: 'Décrivez ce que vous voulez faire.' };
  if (db.length === 0) return { ok: false, attempts: 0, error: 'Votre base de plugins est vide : scannez ou importez vos plugins d\'abord (onglet Plugins).' };
  if (hw.audioOut.length === 0) return { ok: false, attempts: 0, error: 'Indiquez au moins une sortie de votre carte son.' };
  const keep = current ? current.nodes.filter((n) => n.kind === 'plugin' && n.plugin).map((n) => n.plugin as DbPlugin) : [];
  const list = selectForRequest(db, request, opts?.maxCatalog ?? 600, keep);
  const cat = buildCatalog(list, Math.max(1, list.length));
  if (opts?.presets && opts.presets.total + opts.presets.states > 0) {
    const n = buildPresetTable(cat, opts.presets, request, opts.maxPresetLines ?? 120);
    if (n > 0) log(`${n} preset(s) proposé(s) à l'IA pour ${cat.presets?.size ? new Set([...cat.presets.values()].map((p) => p.pluginId)).size : 0} plugin(s).`);
  }
  let currentJson: string | undefined;
  if (current && current.nodes.some((n) => n.kind === 'plugin')) {
    const d = describeProject(current, cat);
    if (d.unknown.length) return { ok: false, attempts: 0, error: `Ces plugins du patchbay ne sont pas dans votre base (ou dans la partie envoyée à l'IA) : ${d.unknown.join(', ')}. Scannez-les d'abord (onglet Plugins), ou retirez-les, ou décochez « Modifier la chaîne actuelle ».` };
    currentJson = d.json;
    log('Modification de la chaîne actuelle du patchbay.');
  }
  if (db.length < 6) log(`Attention : votre base ne contient que ${db.length} plugin(s). L'assistant ne peut choisir que parmi eux : scannez vos dossiers (onglet Plugins) ou utilisez les recettes sans IA.`);
  if (db.length > list.length) log(`Catalogue réduit : ${list.length} plugins sur ${db.length} envoyés à l'IA (les plus pertinents pour votre demande).`);
  const messages: ChatMsg[] = [{ role: 'user', content: userPrompt(request, cat, hw, currentJson) }];
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`Essai ${attempt}/${MAX_ATTEMPTS} : interrogation de l'IA…`);
    const t0 = Date.now();
    const text = await ask(systemPrompt(), messages);
    log(`Essai ${attempt} : réponse reçue en ${Math.round((Date.now() - t0) / 1000)} s, vérification…`);
    let problems: string[] = [];
    try {
      const chain = parseChain(text);
      const result = chainToProject(chain, cat, hw);
      if (result.errors.length === 0) {
        if (current && currentJson) inheritFrom(result.project, current);
        const mono = fanOutMono(result.project);
        if (mono) log(`${mono} câble(s) ajouté(s) : un plugin mono envoie maintenant son son des deux côtés.`);
        log(`Essai ${attempt} : chaîne valide (${result.project.nodes.length} nœuds, ${result.project.cables.length} câbles).`);
        return { ok: true, attempts: attempt, chain, result };
      }
      problems = result.errors;
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    lastError = problems.join(' | ');
    log(`Essai ${attempt} : ${problems.length} problème(s) détecté(s) — ${problems.slice(0, 3).join(' ; ')}${problems.length > 3 ? ' …' : ''}`);
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: `Ta réponse contient ces erreurs, corrige-les et renvoie UNIQUEMENT le JSON complet corrigé :\n- ${problems.join('\n- ')}` });
  }
  return { ok: false, attempts: MAX_ATTEMPTS, error: `L'IA n'a pas produit de chaîne valide après ${MAX_ATTEMPTS} essais. Dernières erreurs : ${lastError}` };
}
