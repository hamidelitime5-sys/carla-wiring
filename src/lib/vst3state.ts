// src/lib/vst3state.ts : état d'un plugin VST3 « Blue Cat's » tel que Carla l'enregistre dans la balise <Chunk>.
//
// Structure observée sur un projet réel (bluecat_chaine.carxp) :
//   chunk = « VC2! » + longueur (entier 32 bits, petit-boutiste) + XML + octet nul
//   XML   = <?xml version="1.0" encoding="UTF-8"?> <VST3PluginState><IComponent>TAILLE.DONNÉES</IComponent></VST3PluginState>
//   TAILLE.DONNÉES = encodage « base64 JUCE » (6 bits par caractère, bits de poids faible d'abord) de :
//   (longueur 32 bits) + document <?xml …?><Preset version="4" progName="…" currentPresetFilePath="…">…</Preset> + octet nul
// Le document <Preset> est le preset lui-même : nom (progName), fichier d'origine (currentPresetFilePath) et tous les réglages.

const TABLE = '.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+';

/** Décode « taille.données » (encodage base64 de JUCE). */
export function juceDecode(text: string): Uint8Array {
  const dot = text.indexOf('.');
  const size = Number(text.slice(0, dot));
  if (!Number.isInteger(size) || size < 0 || dot < 1) throw new Error('Encodage JUCE invalide (taille).');
  const out = new Uint8Array(size);
  let pos = 0;
  for (let i = dot + 1; i < text.length; i++) {
    const v = TABLE.indexOf(text.charAt(i));
    if (v < 0) throw new Error('Encodage JUCE invalide (caractère).');
    for (let k = 0; k < 6; k++, pos++) if (((v >> k) & 1) && (pos >> 3) < size) out[pos >> 3] = (out[pos >> 3] ?? 0) | (1 << (pos & 7));
  }
  return out;
}

/** Encode des octets en « taille.données » (inverse de juceDecode). */
export function juceEncode(bytes: Uint8Array): string {
  const nChars = Math.floor((bytes.length * 8 + 5) / 6);
  let s = `${bytes.length}.`;
  for (let i = 0; i < nChars; i++) {
    let v = 0;
    for (let k = 0; k < 6; k++) {
      const bit = i * 6 + k;
      if (((bytes[bit >> 3] ?? 0) >> (bit & 7)) & 1) v |= 1 << k;
    }
    s += TABLE.charAt(v);
  }
  return s;
}

const u32 = (n: number): Uint8Array => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const readU32 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface BlueCatState {
  presetXml: string; // document <Preset> complet (sans l'octet nul final)
  progName?: string; // nom du preset
  presetPath?: string; // chemin du fichier d'origine, relatif (ex. « Factory Presets/Guitar - Clean + FX/Modu Smooth Delay.preset »)
}

const attr = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<Preset\\b[^>]*?\\b${name}="([^"]*)"`).exec(xml);
  return m?.[1]?.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
};

/**
 * Ouvre l'enveloppe « VC2! » que Carla utilise pour TOUS les plugins VST3 et renvoie l'état interne du plugin (IComponent).
 * Constaté sur Blue Cat's, MeldaProduction, BIAS FX 2 et ReValver. `null` si ce n'est pas cette enveloppe.
 */
export function unwrapVc2(chunkB64: string): Uint8Array | null {
  try {
    const raw = b64ToBytes(chunkB64);
    if (raw.length < 12 || dec.decode(raw.subarray(0, 4)) !== 'VC2!') return null;
    const outer = dec.decode(raw.subarray(8)).replace(/\0+$/, '');
    const m = /<IComponent>([^<]*)<\/IComponent>/.exec(outer);
    return m && m[1] ? juceDecode(m[1].trim()) : null;
  } catch {
    return null;
  }
}

export interface StateCheck { ok: boolean; problem?: string }

/**
 * Vérifie qu'un <Chunk> au format « VC2! » est complet : base64 valide, longueur annoncée = longueur réelle, balises de fin présentes,
 * nombre de caractères encodés conforme à la taille annoncée. Un état tronqué (par exemple écrit à la main ou par une IA qui coupe
 * sa réponse) ne se charge pas dans le plugin. Les autres formats (VST2, vide) ne sont pas vérifiés ici : `ok`.
 */
export function checkVc2State(chunkB64: string): StateCheck {
  const clean = chunkB64.replace(/\s+/g, '');
  if (clean === '') return { ok: true };
  if (clean.length % 4 !== 0) return { ok: false, problem: 'texte base64 incomplet' };
  let raw: Uint8Array;
  try { raw = b64ToBytes(clean); } catch { return { ok: false, problem: 'base64 invalide' }; }
  if (raw.length < 12 || dec.decode(raw.subarray(0, 4)) !== 'VC2!') return { ok: true };
  const declared = readU32(raw, 4);
  if (raw.length !== declared + 9) return { ok: false, problem: `état tronqué : ${declared + 9} octets annoncés, ${raw.length} présents` };
  const outer = dec.decode(raw.subarray(8)).replace(/\0+$/, '');
  if (!outer.includes('</VST3PluginState>')) return { ok: false, problem: 'état tronqué (balise de fin absente)' };
  const m = /<IComponent>(\d+)\.([^<]*)<\/IComponent>/.exec(outer);
  if (!m || !m[2]) return { ok: false, problem: 'état illisible (IComponent absent)' };
  const expected = Math.floor((Number(m[1]) * 8 + 5) / 6);
  if (m[2].length !== expected) return { ok: false, problem: `données incomplètes (${m[2].length} caractères encodés sur ${expected})` };
  return { ok: true };
}

/** Lit un <Chunk> (base64) d'un plugin Blue Cat's VST3 ; `null` si ce n'est pas ce format. */
export function parseBlueCatState(chunkB64: string): BlueCatState | null {
  try {
    const inner = unwrapVc2(chunkB64);
    if (!inner) return null;
    const presetXml = dec.decode(inner.subarray(4)).replace(/\0+$/, '');
    if (!presetXml.includes('<Preset ')) return null;
    return { presetXml, progName: attr(presetXml, 'progName'), presetPath: attr(presetXml, 'currentPresetFilePath') };
  } catch {
    return null;
  }
}

/** Enveloppe « VC2! » de Carla autour de l'état interne d'un plugin VST3 : renvoie le <Chunk> en base64. */
export function wrapVc2(inner: Uint8Array): string {
  const outerXml = enc.encode(`<?xml version="1.0" encoding="UTF-8"?> <VST3PluginState><IComponent>${juceEncode(inner)}</IComponent></VST3PluginState>`);
  const chunk = new Uint8Array(8 + outerXml.length + 1);
  chunk.set(enc.encode('VC2!'), 0); chunk.set(u32(outerXml.length), 4); chunk.set(outerXml, 8); // + octet nul final (déjà à 0)
  return bytesToB64(chunk);
}

/** Fabrique le <Chunk> (base64) d'un plugin Blue Cat's VST3 à partir d'un document <Preset>. */
export function buildBlueCatState(presetXml: string): string {
  const xml = enc.encode(presetXml);
  const innerBytes = new Uint8Array(4 + xml.length + 1);
  innerBytes.set(u32(xml.length + 1), 0); innerBytes.set(xml, 4); // + octet nul final (déjà à 0)
  return wrapVc2(innerBytes);
}

export const _internals = { readU32 };
