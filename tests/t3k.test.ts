// Test : npx tsx tests/t3k.test.ts : conversion .t3kpreset → état TONE3000, vérifiée sur un vrai preset et un vrai projet Carla.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importCarxp } from '../src/lib/carxp';
import { buildT3kState, parseT3kPreset, t3kPresetToChunk } from '../src/lib/t3k';
import { concat, doubleProp, getDouble, getStr, readValueTree, setProp, writeValueTree } from '../src/lib/valuetree';
import { unwrapVc2 } from '../src/lib/vst3state';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const preset = new Uint8Array(readFileSync('tests/fixtures/preset_test.t3kpreset'));
const origChunk = importCarxp(readFileSync('tests/fixtures/tone3000.carxp', 'utf-8')).plugins[0]!.chunk.replace(/\s+/g, '');
const origState = unwrapVc2(origChunk)!;
const FACTORY = { id: 'factory:230b0f41771a499eb99020eccac304bc', name: 'Marshall Bluesbreaker' };

await test('lecture du preset : nom, identifiant, 36 paramètres, chaîne', () => {
  const p = parseT3kPreset(preset);
  assert.equal(p.name, 'hamide test'); assert.equal(p.id, 'fbb429e59e5049738e94c72436598918'); assert.equal(p.params.length, 36);
  assert.equal(p.chain.type, 'ChainSnapshot'); assert.equal(p.params[0]![0], 'inputLevel');
});
await test('PREUVE : preset + gabarit → ÉTAT IDENTIQUE, octet pour octet, à celui que Carla a enregistré (1,3 Mo)', () => {
  const rebuilt = buildT3kState(parseT3kPreset(preset), FACTORY);
  assert.equal(rebuilt.length, origState.length);
  assert.ok(same(rebuilt, origState), 'état identique');
});
await test('PREUVE : et l\'enveloppe VC2! produit exactement le <Chunk> de votre projet Carla', () => {
  const { chunk } = t3kPresetToChunk(preset, FACTORY);
  assert.equal(chunk, origChunk);
});
await test('conversion normale : le preset devient le preset actif ; la chaîne et les paramètres sont repris tels quels', () => {
  const { chunk, name } = t3kPresetToChunk(preset); assert.equal(name, 'hamide test');
  const st = readValueTree(unwrapVc2(chunk)!, 4).tree;
  assert.equal(getStr(st, 'activePresetName'), 'hamide test'); assert.equal(getStr(st, 'activePresetId'), 'fbb429e59e5049738e94c72436598918');
  assert.deepEqual(st.children.map((c) => c.type), ['PARAMETERS', 'MidiMappings', 'ChainSnapshot']);
  const outputLevel = st.children[0]!.children.find((c) => getStr(c, 'id') === 'outputLevel')!;
  assert.ok(Math.abs(getDouble(outputLevel, 'value')! - 0.49) < 1e-6);
});
await test('le réglage propre à la machine (calibration) du gabarit est conservé, ceux du preset l\'emportent', () => {
  const p = parseT3kPreset(preset); p.params = p.params.map(([id, v]) => (id === 'toneBass' ? [id, 7.5] as [string, number] : [id, v]));
  const st = readValueTree(buildT3kState(p), 4).tree; const val = (id: string) => getDouble(st.children[0]!.children.find((c) => getStr(c, 'id') === id)!, 'value');
  assert.equal(val('toneBass'), 7.5); assert.equal(val('inputCalibrationLevel'), 4); assert.equal(val('targetLoudness'), -18);
});
await test('fichiers refusés avec un message clair : mauvais fichier, tronqué, octets en trop, version inconnue, paramètre inconnu', () => {
  assert.throws(() => parseT3kPreset(new Uint8Array(40)), /signature T3KH/);
  assert.throws(() => parseT3kPreset(preset.subarray(0, 200)), /tronqu/);
  assert.throws(() => parseT3kPreset(concat([preset, new Uint8Array([1, 2, 3])])), /inattendus/);
  assert.throws(() => parseT3kPreset(new Uint8Array(0)), /signature/);
  const hl = new DataView(preset.buffer, preset.byteOffset + 4, 4).getUint32(0, true);
  const { tree } = readValueTree(preset, 8 + hl);
  const rebuild = (t: typeof tree) => concat([preset.subarray(0, 8 + hl), writeValueTree(t)]);
  const v2 = structuredClone(tree); v2.props = v2.props.map((p) => (p.name === 'schemaVersion' ? { ...p, payload: new Uint8Array([2, 0, 0, 0]) } : p));
  assert.throws(() => parseT3kPreset(rebuild(v2)), /schemaVersion 2/);
  const unk = structuredClone(tree); const params = unk.children.find((c) => c.type === 'Params')!; setProp(params.children[0]!, { name: 'id', marker: 5, payload: new TextEncoder().encode('nouveauParametre\0') }); setProp(params.children[1]!, doubleProp('value', 1));
  assert.throws(() => buildT3kState(parseT3kPreset(rebuild(unk))), /paramètre inconnu « nouveauParametre »/);
});
console.log(`\n${ok} tests réussis`);
