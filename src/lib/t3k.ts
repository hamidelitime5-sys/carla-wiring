// src/lib/t3k.ts : fichier de preset TONE3000 (.t3kpreset) → état du plugin à écrire dans un projet Carla.
//
// Constaté sur un vrai preset et un vrai projet (tests/fixtures) :
//   .t3kpreset = « T3KH » + longueur (32 bits) + arbre T3KPresetHeader (id, name) + arbre T3KPreset (ChainSnapshot, Params)
//   état Carla = enveloppe VC2! autour de « T3KB » + arbre TONE3000State (PARAMETERS, MidiMappings, ChainSnapshot) + 60 octets
//   La ChainSnapshot (blocs, réglages, modèles NAM/IR embarqués) est IDENTIQUE, octet pour octet, dans les deux.
// Conversion : gabarit de l'état (réglages de la machine) + paramètres du preset + ChainSnapshot du preset.
import { T3K_TAIL_B64, T3K_TEMPLATE_B64 } from './t3kTemplate';
import { concat, doubleProp, getDouble, getInt, getStr, readValueTree, setProp, strProp, writeValueTree, type VtTree } from './valuetree';
import { b64ToBytes, wrapVc2 } from './vst3state';

export interface T3kPreset { id: string; name: string; chain: VtTree; params: Array<[string, number]> }

const ascii = (b: Uint8Array, from: number, n: number): string => String.fromCharCode(...b.subarray(from, from + n));

/** Lit un fichier .t3kpreset. Lève une erreur claire si ce n'est pas le format vérifié. */
export function parseT3kPreset(bytes: Uint8Array): T3kPreset {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== 'T3KH') throw new Error('ce n\'est pas un fichier .t3kpreset (signature T3KH absente)');
  const hl = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  if (hl > bytes.length - 12) throw new Error('fichier .t3kpreset tronqué (en-tête)');
  let hdr: ReturnType<typeof readValueTree>;
  let body: ReturnType<typeof readValueTree>;
  try {
    hdr = readValueTree(bytes, 8);
    body = readValueTree(bytes, 8 + hl);
  } catch (e) {
    throw new Error(`fichier .t3kpreset tronqué ou abîmé (${e instanceof Error ? e.message : String(e)})`);
  }
  if (hdr.end !== 8 + hl || hdr.tree.type !== 'T3KPresetHeader') throw new Error('en-tête de .t3kpreset incohérent');
  const { tree, end } = body;
  if (end !== bytes.length) throw new Error('octets inattendus à la fin du .t3kpreset');
  if (tree.type !== 'T3KPreset') throw new Error(`contenu inattendu (« ${tree.type} » au lieu de T3KPreset)`);
  const sv = getInt(tree, 'schemaVersion');
  if (sv !== 1) throw new Error(`version de preset non prise en charge (schemaVersion ${sv ?? 'absente'}) : seule la version 1 est vérifiée`);
  const chain = tree.children.find((c) => c.type === 'ChainSnapshot');
  const params = tree.children.find((c) => c.type === 'Params');
  if (!chain || !params) throw new Error('chaîne ou paramètres absents du .t3kpreset');
  const list: Array<[string, number]> = [];
  for (const p of params.children) {
    const id = getStr(p, 'id'), v = getDouble(p, 'value');
    if (id === undefined || v === undefined) throw new Error('paramètre illisible dans le .t3kpreset');
    list.push([id, v]);
  }
  return { id: getStr(tree, 'id') ?? getStr(hdr.tree, 'id') ?? '', name: getStr(tree, 'name') ?? getStr(hdr.tree, 'name') ?? 'Preset', chain, params: list };
}

/** Fabrique l'état interne du plugin (celui que Carla enveloppe dans <Chunk>). `active` sert aux tests (identifiant et nom du preset actif). */
export function buildT3kState(preset: T3kPreset, active?: { id: string; name: string }): Uint8Array {
  const root = readValueTree(b64ToBytes(T3K_TEMPLATE_B64)).tree; // copie neuve à chaque appel
  setProp(root, strProp('activePresetId', active?.id ?? preset.id));
  setProp(root, strProp('activePresetName', active?.name ?? preset.name));
  const parameters = root.children.find((c) => c.type === 'PARAMETERS');
  if (!parameters) throw new Error('gabarit TONE3000 invalide');
  const known = new Map(parameters.children.map((c) => [getStr(c, 'id') ?? '', c]));
  for (const [id, v] of preset.params) {
    const c = known.get(id);
    if (!c) throw new Error(`paramètre inconnu « ${id} » : preset d'une version plus récente du plugin, conversion refusée par sécurité`);
    setProp(c, doubleProp('value', v));
  }
  root.children.push(preset.chain);
  return concat([new TextEncoder().encode('T3KB'), writeValueTree(root), b64ToBytes(T3K_TAIL_B64)]);
}

/** .t3kpreset → <Chunk> (base64) prêt pour un projet Carla. */
export function t3kPresetToChunk(bytes: Uint8Array, active?: { id: string; name: string }): { chunk: string; name: string } {
  const preset = parseT3kPreset(bytes);
  return { chunk: wrapVc2(buildT3kState(preset, active)), name: preset.name };
}
