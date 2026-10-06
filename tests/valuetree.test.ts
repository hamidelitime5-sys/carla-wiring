// Test : npx tsx tests/valuetree.test.ts : lecture/écriture des arbres binaires JUCE, vérifiées sur de vrais fichiers TONE3000.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importCarxp } from '../src/lib/carxp';
import { concat, getDouble, getInt, getStr, MARK, readValueTree, writeValueTree, type VtTree } from '../src/lib/valuetree';
import { unwrapVc2 } from '../src/lib/vst3state';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const preset = new Uint8Array(readFileSync('tests/fixtures/preset_test.t3kpreset'));
const comp = unwrapVc2(importCarxp(readFileSync('tests/fixtures/tone3000.carxp', 'utf-8')).plugins[0]!.chunk)!;

await test('lecture de l\'état de Carla (T3KB) : racine, paramètres, chaîne, queue de 60 octets', () => {
  assert.equal(String.fromCharCode(...comp.subarray(0, 4)), 'T3KB');
  const { tree, end } = readValueTree(comp, 4);
  assert.equal(tree.type, 'TONE3000State'); assert.equal(comp.length - end, 60);
  assert.equal(getStr(tree, 'activePresetName'), 'Marshall Bluesbreaker'); assert.equal(getInt(tree, 'schemaVersion'), 1);
  assert.deepEqual(tree.children.map((c) => c.type), ['PARAMETERS', 'MidiMappings', 'ChainSnapshot']);
  assert.equal(tree.children[0]!.children.length, 43);
});
await test('lecture du preset (T3KH + en-tête + T3KPreset) : nom, identifiant, 3 blocs de chaîne, 36 paramètres', () => {
  assert.equal(String.fromCharCode(...preset.subarray(0, 4)), 'T3KH');
  const hl = new DataView(preset.buffer, preset.byteOffset + 4, 4).getUint32(0, true);
  const hdr = readValueTree(preset, 8); assert.equal(hdr.end, 8 + hl); assert.equal(getStr(hdr.tree, 'name'), 'hamide test');
  const { tree, end } = readValueTree(preset, 8 + hl); assert.equal(end, preset.length);
  assert.equal(tree.type, 'T3KPreset'); assert.deepEqual(tree.children.map((c) => c.type), ['ChainSnapshot', 'Params']);
  const blocks = tree.children[0]!.children[0]!.children.filter((b) => getStr(b, 'type') !== 'insert');
  assert.deepEqual(blocks.map((b) => getStr(b, 'type')), ['nam', 'nam', 'ir']);
  assert.equal(tree.children[1]!.children.length, 36);
  assert.equal(getDouble(tree.children[1]!.children[0]!, 'value'), 0.5);
});
await test('RELIRE puis RÉÉCRIRE redonne exactement les mêmes octets (état de 1,3 Mo et preset de 1,3 Mo)', () => {
  const s = readValueTree(comp, 4); assert.ok(same(writeValueTree(s.tree), comp.subarray(4, s.end)), 'état');
  const hl = new DataView(preset.buffer, preset.byteOffset + 4, 4).getUint32(0, true);
  const p = readValueTree(preset, 8 + hl); assert.ok(same(writeValueTree(p.tree), preset.subarray(8 + hl)), 'preset');
});
await test('écriture : entiers compressés (0, 1, 255, 256, 70000, négatif) et variantes vides', () => {
  const t: VtTree = { type: 'T', props: [{ name: 'a', marker: -1, payload: new Uint8Array(0) }, { name: 'b', marker: MARK.int, payload: new Uint8Array([1, 0, 0, 0]) }], children: [] };
  const w = writeValueTree(t); const back = readValueTree(w);
  assert.equal(back.end, w.length); assert.equal(back.tree.props[0]!.marker, -1); assert.equal(getInt(back.tree, 'b'), 1);
  const many: VtTree = { type: 'M', props: [], children: Array.from({ length: 70000 }, () => ({ type: 'c', props: [], children: [] })) };
  assert.equal(readValueTree(writeValueTree(many)).tree.children.length, 70000);
  assert.ok(same(concat([new Uint8Array([1, 2]), new Uint8Array([3])]), new Uint8Array([1, 2, 3])));
});
await test('données abîmées : erreur claire, jamais de plantage ni de boucle', () => {
  assert.throws(() => readValueTree(preset.subarray(0, 300), 8 + 78), /tronqu/);
  assert.throws(() => readValueTree(new Uint8Array([0x41, 0x42])), /tronqu/);
  assert.throws(() => readValueTree(new Uint8Array([0x41, 0, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9])), /invalide/);
});
console.log(`\n${ok} tests réussis`);
