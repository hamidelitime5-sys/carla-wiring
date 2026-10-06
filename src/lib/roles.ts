// src/lib/roles.ts : à quoi sert chaque plugin ? (ampli, compresseur, réverbération…) d'après son nom.
// Heuristique simple et corrigeable à la main (liste « Rôle » de l'onglet Plugins) : le scan ne donne qu'une catégorie très large.
import type { DbPlugin } from './carxp';
import { dbKey } from './pluginsdb';

export type Role = 'multi' | 'amp' | 'cab' | 'drive' | 'comp' | 'eq' | 'mod' | 'wah' | 'delay' | 'reverb' | 'limiter' | 'gate' | 'tool' | 'synth';

export const ROLES: Role[] = ['multi', 'amp', 'cab', 'drive', 'comp', 'eq', 'mod', 'wah', 'delay', 'reverb', 'limiter', 'gate', 'tool', 'synth'];

export const ROLE_LABEL: Record<Role, string> = {
  multi: 'Tout-en-un (ampli + effets)', amp: 'Ampli', cab: 'Baffle / IR', drive: 'Saturation / boost', comp: 'Compresseur', eq: 'Égaliseur',
  mod: 'Modulation (chorus, flanger…)', wah: 'Wah', delay: 'Delay / écho', reverb: 'Réverbération', limiter: 'Limiteur', gate: 'Noise gate',
  tool: 'Outil (looper, mixeur, mesure)', synth: 'Instrument (synthé, sampler)',
};

const plain = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const TOOL = /loop ?recorder|looper|mixer|fader|connector|\bmeter|analy[sz]er|spectrum|tuner|triple ?play|utility|router|midi/;
const MULTI = /guitar ?rig|bias ?(fx|amp|x)?\b|revalver|tone ?3000|amplitube|axiom|tonex|neural ?amp|helix|kemper|archetype|nembrini|th-?u\b/;
const RULES: Array<[Role, RegExp]> = [
  ['amp', /\bamp\b|\bampli|twin|marshall|plexi|\bvox\b|fender|mesa|ampeg|\bsvt\b|bassman|jc-?120|jazz ?chorus|deluxe reverb|vibrolux|princeton|jtm/],
  ['cab', /\bcab\b|cabinet|\bir\b|impulse|convol|mcabinet|speaker/],
  ['drive', /overdrive|distort|fuzz|boost|screamer|\bts[-\s]?\d|muff|saturat|\bdrive\b|\bdist\b|crunch|octavia/],
  ['comp', /compress|\bcomp\b|dynamics|1176|la-?2a|opto|leveler|glue|\bdyn\b/],
  ['limiter', /limiter|maximi[sz]er|protect|brickwall|loudness|\bl[12]\b/],
  ['eq', /\beq\b|equali[sz]|parametric|liny|filter|tone ?stack/],
  ['mod', /chorus|flanger|phaser|tremolo|vibrato|rotary|leslie|modulat/],
  ['wah', /\bwah\b|cry ?baby/],
  ['delay', /delay|echo|space ?echo|slapback|late replies/],
  ['reverb', /reverb|\bverb\b|spring|\bplate\b|\bhall\b|\broom\b|shimmer/],
  ['gate', /\bgate\b|expander|denois|noise ?reduc/],
];

/** Rôles probables d'un plugin d'après son nom (vide si on ne sait pas). */
export function guessRoles(p: DbPlugin): Role[] {
  const n = plain(p.name);
  if (TOOL.test(n)) return ['tool'];
  if (MULTI.test(n)) return ['multi'];
  if (p.isSynth) return ['synth'];
  const found = RULES.filter(([, re]) => re.test(n)).map(([r]) => r);
  // un nom d'ampli (« Twin Reverb », « Jazz Chorus », « Marshall … Overdrive ») contient souvent des mots d'effets : l'ampli l'emporte
  return found.includes('amp') ? ['amp'] : found;
}

/** Rôles d'un plugin, en tenant compte des corrections de l'utilisateur (clé = chemin|nom). */
export function rolesOf(p: DbPlugin, overrides: Record<string, Role | ''> = {}): Role[] {
  const o = overrides[dbKey(p)];
  return o ? [o] : guessRoles(p);
}

/** Nombre de plugins par rôle (pour expliquer ce qui manque dans la base). */
export function roleCounts(db: DbPlugin[], overrides: Record<string, Role | ''> = {}): Record<Role | 'none', number> {
  const out = Object.fromEntries([...ROLES, 'none'].map((r) => [r, 0])) as Record<Role | 'none', number>;
  for (const p of db) { const r = rolesOf(p, overrides); if (!r.length) out.none++; for (const x of r) out[x]++; }
  return out;
}
