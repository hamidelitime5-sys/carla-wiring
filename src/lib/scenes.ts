// src/lib/scenes.ts : scènes pour le live = variantes d'un même rig (son clair, saturé, solo…),
// obtenues en contournant certains plugins et/ou en changeant le câblage. Chaque scène s'exporte en fichier .carxp séparé.
import { exportCarxp, nodePorts, validateProject, type PatchCable, type PatchProject, type Scene } from './carxp';
import type { AskFn, ChatMsg } from './chain';
import { extractJson } from './chain';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function nextId(list: Scene[]): string {
  let i = list.length + 1;
  while (list.some((s) => s.id === `s${i}`)) i++;
  return `s${i}`;
}

/** Photographie l'état actuel (plugins contournés + câblage) sous un nom. Un nom existant est remplacé. */
export function saveScene(project: PatchProject, name: string): string | null {
  const clean = name.trim();
  if (!clean) return 'Donnez un nom à la scène.';
  if (!project.nodes.some((n) => n.kind === 'plugin')) return 'Le patchbay ne contient aucun plugin.';
  const scenes = project.scenes ?? [];
  const snap = { name: clean, bypass: project.nodes.filter((n) => n.kind === 'plugin' && n.bypass).map((n) => n.id), cables: clone(project.cables) };
  const i = scenes.findIndex((s) => s.name.toLowerCase() === clean.toLowerCase());
  if (i >= 0) scenes[i] = { ...snap, id: scenes[i]?.id ?? nextId(scenes) };
  else scenes.push({ ...snap, id: nextId(scenes) });
  project.scenes = scenes;
  return null;
}

export function removeScene(project: PatchProject, id: string): void {
  project.scenes = (project.scenes ?? []).filter((s) => s.id !== id);
}

function cableValid(project: PatchProject, c: PatchCable): boolean {
  const a = project.nodes.find((n) => n.id === c.fromNode);
  const b = project.nodes.find((n) => n.id === c.toNode);
  if (!a || !b) return false;
  const out = nodePorts(a, project.hardware).outputs.find((p) => p.name === c.fromPort);
  const inp = nodePorts(b, project.hardware).inputs.find((p) => p.name === c.toPort);
  return !!out && !!inp && out.type === inp.type;
}

/** Applique une scène : contournements + câblage. `ignored` = câbles de la scène qui n'existent plus (plugin ou port supprimé). */
export function applyScene(project: PatchProject, id: string): { error?: string; ignored: number } {
  const scene = (project.scenes ?? []).find((s) => s.id === id);
  if (!scene) return { error: 'Scène introuvable.', ignored: 0 };
  for (const n of project.nodes) if (n.kind === 'plugin') n.bypass = scene.bypass.includes(n.id);
  const valid = scene.cables.filter((c) => cableValid(project, c));
  project.cables = clone(valid);
  return { ignored: scene.cables.length - valid.length };
}

/** Erreurs qui empêcheraient d'exporter la scène (sans modifier le patchbay). */
export function validateScene(project: PatchProject, id: string): string[] {
  const copy = clone(project);
  const r = applyScene(copy, id);
  if (r.error) return [r.error];
  return [...new Set(validateProject(copy, { requirePluginFiles: true }).filter((i) => i.level === 'error').map((i) => i.message))];
}

export function sanitizeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return s || 'scene';
}

export interface SceneFile { scene: Scene; fileName: string; xml: string }

/** Un fichier .carxp par scène (le patchbay actuel n'est pas modifié). */
export function planSceneFiles(project: PatchProject, base: string, center = true): SceneFile[] {
  const out: SceneFile[] = [];
  const used = new Set<string>();
  for (const scene of project.scenes ?? []) {
    const copy = clone(project);
    applyScene(copy, scene.id);
    let fileName = `${sanitizeFileName(base)}_${sanitizeFileName(scene.name)}.carxp`;
    let k = 2;
    while (used.has(fileName.toLowerCase())) fileName = `${sanitizeFileName(base)}_${sanitizeFileName(scene.name)}-${k++}.carxp`;
    used.add(fileName.toLowerCase());
    out.push({ scene, fileName, xml: exportCarxp(copy, true, { center }) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scènes proposées par l'IA (uniquement par contournement des plugins existants)

export function scenesSystemPrompt(): string {
  return [
    'Tu es un ingénieur du son spécialisé dans le LIVE. On te donne un rig existant (plugins numérotés, avec leur nom et leur rôle).',
    'Tu proposes des SCÈNES : des variantes de ce rig obtenues UNIQUEMENT en contournant (bypass) certains plugins EXISTANTS.',
    'Un plugin contourné laisse passer le signal sans traitement ; un instrument contourné ne produit plus de son.',
    '',
    'Réponds UNIQUEMENT par un objet JSON de cette forme :',
    '{ "scenes": [ { "name": "Clair", "bypass": ["n2", "n4"], "why": "pourquoi" } ], "notes": ["conseil pour passer d\'une scène à l\'autre"] }',
    '',
    'Règles :',
    '- 2 à 6 scènes, avec des noms courts, distincts, sans / \\ : * ? " < > |.',
    '- "bypass" ne contient que des identifiants de plugins de la liste fournie ; une liste vide = tous les plugins actifs.',
    '- Ne contourne pas tous les instruments dans une même scène (sinon plus de son).',
    '- Tiens compte de la demande de l\'utilisateur (ex. « clair, saturé, solo »).',
  ].join('\n');
}

export function describeForScenes(project: PatchProject): string {
  const lines = project.nodes.filter((n) => n.kind === 'plugin' && n.plugin).map((n) => {
    const p = n.plugin;
    return `${n.id} | ${n.name} | ${p?.isSynth ? 'instrument' : 'effet'} | ${p?.type ?? ''}${n.bypass ? ' | actuellement contourné' : ''}`;
  });
  return lines.join('\n');
}

export interface SceneProposal { name: string; bypass: string[]; why?: string }

export function validateSceneProposals(raw: unknown, project: PatchProject): { scenes: SceneProposal[]; notes: string[]; errors: string[] } {
  const errors: string[] = [];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.scenes) ? o.scenes : [];
  const notes = Array.isArray(o.notes) ? o.notes.filter((x): x is string => typeof x === 'string') : [];
  const plugins = project.nodes.filter((n) => n.kind === 'plugin' && n.plugin);
  const ids = new Set(plugins.map((n) => n.id));
  const instruments = plugins.filter((n) => n.plugin?.isSynth).map((n) => n.id);
  const scenes: SceneProposal[] = [];
  const names = new Set<string>();
  if (list.length < 1 || list.length > 8) errors.push(`Il faut entre 1 et 8 scènes (reçu : ${list.length}).`);
  for (const x of list) {
    const s = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const bypass = Array.isArray(s.bypass) ? s.bypass.filter((b): b is string => typeof b === 'string') : [];
    if (!name) { errors.push('Une scène n\'a pas de nom.'); continue; }
    if (names.has(name.toLowerCase())) { errors.push(`Nom de scène en double : « ${name} ».`); continue; }
    names.add(name.toLowerCase());
    const unknown = bypass.filter((b) => !ids.has(b));
    if (unknown.length) { errors.push(`Scène « ${name} » : identifiant(s) de plugin inconnu(s) : ${unknown.join(', ')} (autorisés : ${[...ids].join(', ')}).`); continue; }
    if (instruments.length > 0 && instruments.every((i) => bypass.includes(i))) { errors.push(`Scène « ${name} » : tous les instruments sont contournés, il n'y aurait plus de son.`); continue; }
    if (plugins.length > 0 && plugins.every((n) => bypass.includes(n.id))) { errors.push(`Scène « ${name} » : tous les plugins sont contournés.`); continue; }
    scenes.push({ name, bypass: [...new Set(bypass)], why: typeof s.why === 'string' ? s.why : undefined });
  }
  return { scenes, notes, errors };
}

export interface ScenesOutcome { ok: boolean; attempts: number; scenes?: SceneProposal[]; notes?: string[]; error?: string }

export async function generateScenes(ask: AskFn, request: string, project: PatchProject, log: (l: string) => void): Promise<ScenesOutcome> {
  if (!project.nodes.some((n) => n.kind === 'plugin' && n.plugin)) return { ok: false, attempts: 0, error: 'Le patchbay ne contient aucun plugin.' };
  const messages: ChatMsg[] = [{ role: 'user', content: `DEMANDE : ${request.trim() || 'propose des variantes utiles pour le live'}\n\nRIG (id | nom | rôle | format) :\n${describeForScenes(project)}` }];
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Essai ${attempt}/3 : interrogation de l'IA…`);
    const text = await ask(scenesSystemPrompt(), messages);
    let problems: string[];
    try {
      const v = validateSceneProposals(extractJson(text), project);
      if (v.errors.length === 0) { log(`Essai ${attempt} : ${v.scenes.length} scène(s) valides.`); return { ok: true, attempts: attempt, scenes: v.scenes, notes: v.notes }; }
      problems = v.errors;
    } catch (e) { problems = [e instanceof Error ? e.message : String(e)]; }
    last = problems.join(' | ');
    log(`Essai ${attempt} : ${problems.length} problème(s) — ${problems.slice(0, 2).join(' ; ')}`);
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Ta réponse contient ces erreurs, corrige-les et renvoie UNIQUEMENT le JSON complet corrigé :\n- ${problems.join('\n- ')}` });
  }
  return { ok: false, attempts: 3, error: `L'IA n'a pas produit de scènes valides après 3 essais. Dernières erreurs : ${last}` };
}

/** Ajoute les scènes proposées (avec le câblage actuel) ; un nom existant est remplacé. */
export function addProposedScenes(project: PatchProject, proposals: SceneProposal[]): number {
  const scenes = project.scenes ?? [];
  for (const p of proposals) {
    const snap = { name: p.name, bypass: p.bypass, cables: clone(project.cables) };
    const i = scenes.findIndex((s) => s.name.toLowerCase() === p.name.toLowerCase());
    if (i >= 0) scenes[i] = { ...snap, id: scenes[i]?.id ?? nextId(scenes) }; else scenes.push({ ...snap, id: nextId(scenes) });
  }
  project.scenes = scenes;
  return proposals.length;
}
