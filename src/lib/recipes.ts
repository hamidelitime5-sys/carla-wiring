// src/lib/recipes.ts : recettes de sons (sans IA) et constructeur de chaîne par règles.
//
// Chaque recette est une suite d'ÉTAPES (rôles de plugins dans l'ordre du signal). Le constructeur choisit, pour chaque étape,
// le meilleur plugin de VOTRE base (par rôle, puis par mots préférés), propose un preset ou un son capturé s'il en existe,
// et câble le tout en série de la carte son à la carte son. Instantané, gratuit, sans erreur de syntaxe possible.
// Sources des recettes : matériel documenté par les guitaristes eux-mêmes (voir « sources ») ; la chaîne proposée est une
// synthèse, à régler à l'oreille. Le choix du micro, des cordes et la technique de jeu ne se règlent pas dans un plugin.
import type { DbPlugin, HardwareProfile, PatchNode, PatchProject, PortInfo } from './carxp';
import { nodePorts } from './carxp';
import { addPlugin, autoLayout, connect, emptyProject, ensureHardware } from './editor';
import { applyPreset, type PresetBook, type PresetCandidate } from './presets';
import { rolesOf, ROLE_LABEL, type Role } from './roles';
import { dbKey } from './pluginsdb';

/** `strict` : une étape facultative n'est retenue que si le plugin porte l'un des mots préférés (une fuzz n'est pas un boost de type Tube Screamer). */
export interface RecipeStep { role: Role; optional?: boolean; strict?: boolean; prefer: string[]; why: string }
export interface Recipe {
  id: string; label: string; summary: string; steps: RecipeStep[]; presetWords: string[]; tips: string[]; sources: string;
}

export const RECIPES: Recipe[] = [
  {
    id: 'jazz-benson', label: 'Jazz — George Benson', summary: 'Son propre, rond et chaud, très peu d\'effets.',
    steps: [
      { role: 'comp', optional: true, prefer: ['opto', 'la-2a', 'soft'], why: 'compression très légère' },
      { role: 'amp', prefer: ['twin', 'deluxe', 'fender', 'jazz', 'clean', 'warm', 'benson'], why: 'ampli propre de type Twin Reverb' },
      { role: 'eq', optional: true, prefer: ['warm'], why: 'graves chauds, aigus adoucis' },
      { role: 'reverb', optional: true, prefer: ['spring', 'plate'], why: 'un soupçon de réverbération à ressort' },
    ],
    presetWords: ['jazz', 'benson', 'clean', 'warm', 'twin'],
    tips: ['Micro manche, potentiomètre de tonalité baissé.', 'Cordes filées plates, moyennes ou lourdes.'],
    sources: 'Vintage Guitar, Equipboard (Fender Twin Reverb, boîtier de direct)',
  },
  {
    id: 'reggae', label: 'Reggae — rythmique générale', summary: 'Son propre et brillant, court, avec un peu de ressort.',
    steps: [
      { role: 'comp', optional: true, prefer: ['opto', 'soft'], why: 'compression légère pour tenir dans le mix' },
      { role: 'amp', prefer: ['jazz chorus', 'jc', 'twin', 'clean', 'bright'], why: 'ampli propre brillant (type Jazz Chorus)' },
      { role: 'eq', optional: true, prefer: ['bright'], why: 'médiums et aigus en avant, peu de graves' },
      { role: 'reverb', optional: true, prefer: ['spring'], why: 'réverbération à ressort légère' },
      { role: 'delay', optional: true, prefer: ['short', 'slap'], why: 'delay court (facultatif)' },
    ],
    presetWords: ['reggae', 'clean', 'bright', 'jazz chorus', 'jc', 'twin'],
    tips: ['Micro chevalet pour le « skank » bien clair.', 'Gain très bas ; réglages d\'ampli indicatifs : graves 4, médiums 5, aigus 6, reverb 3.'],
    sources: 'Guitar World, HoRNet (ampli à transistors des guitaristes de Marley)',
  },
  {
    id: 'reggae-anderson', label: 'Reggae — Al Anderson (solo)', summary: 'Rond, bluesy et chantant. Matériel peu documenté : recette provisoire.',
    steps: [
      { role: 'comp', optional: true, prefer: ['opto', 'soft'], why: 'compression légère' },
      { role: 'amp', prefer: ['marshall', 'plexi', 'crunch', 'blues', 'jtm'], why: 'ampli au bord du crunch' },
      { role: 'eq', optional: true, prefer: ['warm'], why: 'médiums chauds' },
      { role: 'reverb', optional: true, prefer: ['hall', 'room', 'ambient'], why: 'réverbération assez ambiante' },
    ],
    presetWords: ['blues', 'crunch', 'marshall', 'warm', 'anderson'],
    tips: ['Jeu lent, plein de feeling, licks blues et country.', 'Référence : le solo de « No Woman, No Cry » (Live!, 1975).'],
    sources: 'Guitar World (entretien) ; avis de forum pour le matériel : confiance faible',
  },
  {
    id: 'reggae-marvin-rythmique', label: 'Reggae — Junior Marvin (rythmique wah)', summary: 'Twin propre avec wah calé pour le « chop ».',
    steps: [
      { role: 'wah', prefer: ['wah'], why: 'wah calé en position brillante pour le chop' },
      { role: 'amp', prefer: ['twin', 'fender', 'clean'], why: 'ampli Twin propre' },
      { role: 'eq', optional: true, prefer: ['bright'], why: 'aigus en avant' },
      { role: 'reverb', optional: true, prefer: ['spring'], why: 'réverbération à ressort' },
    ],
    presetWords: ['reggae', 'wah', 'twin', 'clean'],
    tips: ['Cordes étouffées, wah calé sur l\'aigu : le « chop » rythmique.'],
    sources: 'Vintage Guitar, Guitars Exchange (Strat, Cry Baby, Twin Reverb)',
  },
  {
    id: 'reggae-marvin-solo', label: 'Reggae — Junior Marvin (solo)', summary: 'Twin au bord de la saturation, fuzz léger, ressort.',
    steps: [
      { role: 'drive', optional: true, strict: true, prefer: ['octavia', 'fuzz', 'boost'], why: 'fuzz ou boost léger' },
      { role: 'amp', prefer: ['twin', 'fender', 'crunch'], why: 'ampli Twin au bord de la saturation' },
      { role: 'reverb', optional: true, prefer: ['spring'], why: 'réverbération à ressort' },
      { role: 'delay', optional: true, prefer: ['analog', 'tape'], why: 'delay' },
    ],
    presetWords: ['reggae', 'twin', 'fuzz', 'lead'],
    tips: ['Son entre Hendrix et Curtis Mayfield.'],
    sources: 'Guitars Exchange, Vintage Guitar',
  },
  {
    id: 'funk-rodgers', label: 'Funk — Nile Rodgers', summary: 'Très propre, brillant, compressé, pour les doubles croches.',
    steps: [
      { role: 'comp', prefer: ['1176', 'opto', 'fast'], why: 'compression assez marquée' },
      { role: 'amp', prefer: ['fender', 'vibrolux', 'twin', 'deluxe', 'princeton', 'bright', 'clean'], why: 'ampli propre brillant de type Fender' },
      { role: 'eq', optional: true, prefer: ['bright'], why: 'accent sur aigus et hauts-médiums' },
    ],
    presetWords: ['funk', 'clean', 'bright', 'compress', 'fender'],
    tips: ['Micro manche, cordes 009-042, jeu « chucking » (doubles croches syncopées).', 'Mélange ampli et signal direct propre si possible.'],
    sources: 'Bonedo, Premier Guitar, Guitar Player (Strat « Hitmaker », Fender Vibrolux)',
  },
  {
    id: 'clapton', label: 'Classique — Eric Clapton', summary: 'Crunch chaud et lisse type Marshall, médiums marqués.',
    steps: [
      { role: 'drive', optional: true, strict: true, prefer: ['boost', 'mid', 'screamer', 'ts'], why: 'boost de médiums' },
      { role: 'amp', prefer: ['marshall', 'jtm', 'plexi', 'bluesbreaker', 'crunch', 'blues'], why: 'ampli crunch de type Marshall' },
      { role: 'cab', optional: true, prefer: ['marshall', '4x12'], why: 'baffle' },
      { role: 'eq', optional: true, prefer: ['warm', 'dark'], why: 'aigus adoucis (effet du potentiomètre de tonalité)' },
    ],
    presetWords: ['clapton', 'blues', 'crunch', 'marshall', 'bluesbreaker', 'jtm45', 'woman'],
    tips: ['« Woman tone » : micro manche, potentiomètre de tonalité baissé.'],
    sources: 'Killer Guitar Rigs, Fender (Strat Blackie, boost de médiums actif)',
  },
  {
    id: 'santana-europa', label: 'Lead — Santana, « Europa »', summary: 'Lead chaud et chantant, long sustain, médiums marqués, peu d\'attaque.',
    steps: [
      { role: 'comp', optional: true, prefer: ['opto', 'la-2a', 'soft'], why: 'compression douce : sustain et moins d\'attaque' },
      { role: 'drive', optional: true, strict: true, prefer: ['screamer', 'ts', 'sd-1', 'boost', 'overdrive'], why: 'boost de type Tube Screamer qui pousse l\'ampli' },
      { role: 'amp', prefer: ['mesa', 'boogie', 'mark', 'rectifier', 'crunch', 'lead', 'marshall', 'plexi'], why: 'ampli de type Mesa/Boogie, du clair-crunch au crunch poussé' },
      { role: 'eq', optional: true, prefer: ['mid', 'warm'], why: 'médiums en avant (graves 4-5, médiums 7-8, aigus 5-6)' },
      { role: 'delay', optional: true, prefer: ['tape', 'echoplex', 'analog', 'slap'], why: 'écho à bande discret' },
      { role: 'reverb', optional: true, prefer: ['plate', 'hall'], why: 'réverbération plate ou hall' },
    ],
    presetWords: ['santana', 'europa', 'lead', 'sustain', 'crunch', 'mesa', 'boogie', 'singing', 'warm'],
    tips: ['Micro manche (humbucker) uniquement ; vibrato large et lent, attaque du médiator contrôlée : la technique fait une grande partie du son.', 'Réglages d\'ampli indicatifs : gain 7, médiums 8, aigus 5, graves 4-5.'],
    sources: 'ToneStakr, Riffhard, Guitar Chalk (Mesa/Boogie Mark I, PRS Custom 22 sur « Europa », 1976) ; réglages indicatifs',
  },
  {
    id: 'police-summers', label: 'Classique — The Police (Andy Summers)', summary: 'Clean avec chorus, écho et compression.',
    steps: [
      { role: 'amp', prefer: ['jazz chorus', 'jc', 'clean'], why: 'ampli propre (Roland JC-120)' },
      { role: 'mod', prefer: ['chorus', 'flanger', 'mistress'], why: 'chorus / flanger qui scintille' },
      { role: 'delay', prefer: ['analog', 'tape', 'echo'], why: 'écho analogique' },
      { role: 'comp', optional: true, prefer: ['dyna', 'opto'], why: 'compresseur (placement variable selon les sources)' },
    ],
    presetWords: ['police', 'chorus', 'clean', 'delay', 'echo', 'jc'],
    tips: ['Telecaster : micro chevalet simple bobinage, micro manche humbucker.', 'Écho en triolets de noires.'],
    sources: 'Guitar Player, Premier Guitar, Bonedo, Guitar Tricks',
  },
];

export interface BuildOptions {
  /** Entrée de la carte son où la guitare est branchée (nom de port). Par défaut : le dernier port, ou celui nommé « Right ». */
  guitarInput?: string;
  /** Mots supplémentaires (ex. la demande écrite) pour choisir presets et plugins. */
  extraWords?: string;
  roleOverrides?: Record<string, Role | ''>;
}

export interface BuildStep { role: Role; why: string; optional: boolean; plugin?: DbPlugin; preset?: PresetCandidate; note?: string }
export interface BuildResult { project: PatchProject; steps: BuildStep[]; missing: Role[]; notes: string[]; ok: boolean }

const plain = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const audioIn = (n: PatchNode, hw: HardwareProfile): PortInfo[] => nodePorts(n, hw).inputs.filter((i) => i.type === 'audio');
const audioOut = (n: PatchNode, hw: HardwareProfile): PortInfo[] => nodePorts(n, hw).outputs.filter((o) => o.type === 'audio');

export function defaultGuitarInput(hw: HardwareProfile): string {
  return hw.audioIn.find((n) => /right|droit/i.test(n)) ?? hw.audioIn[hw.audioIn.length - 1] ?? hw.audioIn[0] ?? 'capture_1';
}

/** Relie les sorties audio de `a` aux entrées audio de `b` (mono ↔ stéréo gérés). */
function linkAudio(p: PatchProject, a: PatchNode, b: PatchNode): void {
  const outs = audioOut(a, p.hardware), ins = audioIn(b, p.hardware);
  if (!outs.length || !ins.length) return;
  const o1 = (outs[0] as PortInfo).name, i1 = (ins[0] as PortInfo).name;
  if (outs.length >= 2 && ins.length >= 2) { connect(p, { node: a.id, port: o1 }, { node: b.id, port: i1 }); connect(p, { node: a.id, port: (outs[1] as PortInfo).name }, { node: b.id, port: (ins[1] as PortInfo).name }); }
  else if (outs.length === 1 && ins.length >= 2) { connect(p, { node: a.id, port: o1 }, { node: b.id, port: i1 }); connect(p, { node: a.id, port: o1 }, { node: b.id, port: (ins[1] as PortInfo).name }); }
  else if (outs.length >= 2 && ins.length === 1) { connect(p, { node: a.id, port: o1 }, { node: b.id, port: i1 }); connect(p, { node: a.id, port: (outs[1] as PortInfo).name }, { node: b.id, port: i1 }); }
  else connect(p, { node: a.id, port: o1 }, { node: b.id, port: i1 });
}

/** Construit la chaîne d'une recette avec les plugins de la base. Ne lève jamais d'exception : les manques sont signalés. */
export function buildFromRecipe(recipe: Recipe, db: DbPlugin[], hw: HardwareProfile, book?: PresetBook, opts: BuildOptions = {}): BuildResult {
  const overrides = opts.roleOverrides ?? {};
  const usable = db.filter((p) => p.audioIns >= 1 && p.audioOuts >= 1);
  const words = [...recipe.presetWords, opts.extraWords ?? ''].join(' ');
  const presetBonus = (p: DbPlugin): number => (book && book.forPlugin(p, words, 1, 3).length > 0 ? 20 : 0);
  const used = new Set<string>();
  const steps: BuildStep[] = [];
  const missing: Role[] = [];
  // Sans ampli « pur » dans la base, un plugin tout-en-un tient lieu d'ampli : baffle et boost sont alors déjà inclus (décidé AVANT de parcourir les étapes)
  const hasAmp = usable.some((p) => rolesOf(p, overrides).includes('amp'));
  let multiUsed = recipe.steps.some((s) => s.role === 'amp') && !hasAmp && usable.some((p) => rolesOf(p, overrides).includes('multi'));

  for (const step of recipe.steps) {
    const base: BuildStep = { role: step.role, why: step.why, optional: !!step.optional };
    if (multiUsed && (step.role === 'cab' || step.role === 'drive')) { steps.push({ ...base, note: 'déjà inclus dans le plugin tout-en-un' }); continue; }
    const pool = (role: Role): DbPlugin[] => usable.filter((p) => !used.has(dbKey(p)) && rolesOf(p, overrides).includes(role));
    const score = (p: DbPlugin): number => {
      const n = plain(p.name);
      return step.prefer.filter((k) => n.includes(k)).length * 5 + presetBonus(p) + (/bass|basse/.test(n) ? -3 : 0);
    };
    let cands = pool(step.role);
    let viaMulti = false;
    if (!cands.length && step.role === 'amp') { cands = pool('multi'); viaMulti = cands.length > 0; }
    if (!cands.length) {
      steps.push({ ...base, note: step.optional ? 'aucun plugin de ce type dans votre base (étape facultative ignorée)' : 'aucun plugin de ce type dans votre base' });
      if (!step.optional) missing.push(step.role);
      continue;
    }
    const best = [...cands].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0] as DbPlugin;
    if (step.strict && step.optional && !step.prefer.some((k) => plain(best.name).includes(k))) { steps.push({ ...base, note: 'aucun plugin adapté dans votre base (étape facultative ignorée)' }); continue; }
    used.add(dbKey(best));
    if (viaMulti) multiUsed = true;
    steps.push({ ...base, plugin: best, ...(viaMulti ? { note: 'plugin tout-en-un utilisé comme ampli' } : {}) });
  }

  const chosen = steps.filter((s) => s.plugin);
  const project = emptyProject(hw);
  if (!chosen.length) return { project, steps, missing, notes: [...recipe.tips], ok: false };

  const nodes: PatchNode[] = chosen.map((s) => addPlugin(project, s.plugin as DbPlugin));
  const hin = ensureHardware(project, 'hw-in'), hout = ensureHardware(project, 'hw-out');
  const src = opts.guitarInput && hw.audioIn.includes(opts.guitarInput) ? opts.guitarInput : defaultGuitarInput(hw);
  const first = nodes[0] as PatchNode;
  const firstIns = audioIn(first, hw);
  firstIns.slice(0, 2).forEach((i) => connect(project, { node: hin.id, port: src }, { node: first.id, port: i.name }));
  for (let i = 0; i + 1 < nodes.length; i++) linkAudio(project, nodes[i] as PatchNode, nodes[i + 1] as PatchNode);
  linkAudio(project, nodes[nodes.length - 1] as PatchNode, hout);
  autoLayout(project);

  if (book) {
    chosen.forEach((s, i) => {
      const cand = book.forPlugin(s.plugin as DbPlugin, [...recipe.presetWords, ...(opts.extraWords ? [opts.extraWords] : [])].join(' '), 1, 3)[0];
      if (cand) { applyPreset(nodes[i] as PatchNode, cand); s.preset = cand; }
    });
  }
  return { project, steps, missing, notes: [...recipe.tips], ok: true };
}

export const stepLabel = (s: BuildStep): string => `${ROLE_LABEL[s.role]}${s.optional ? ' (facultatif)' : ''}`;

/** Recette la plus proche d'une demande écrite (mots-clés simples), ou `undefined`. */
export function suggestRecipe(request: string): Recipe | undefined {
  const t = plain(request);
  const rules: Array<[RegExp, string]> = [
    [/santana|europa|abraxas|carlos/, 'santana-europa'], [/junior|marvin/, 'reggae-marvin-rythmique'], [/anderson/, 'reggae-anderson'], [/reggae|marley|ska/, 'reggae'], [/benson|jazz/, 'jazz-benson'],
    [/funk|rodgers|nile|chic|freak/, 'funk-rodgers'], [/clapton|cream|blues/, 'clapton'], [/police|sting|summers/, 'police-summers'],
  ];
  const hit = rules.find(([re]) => re.test(t));
  return hit ? RECIPES.find((r) => r.id === hit[1]) : undefined;
}
