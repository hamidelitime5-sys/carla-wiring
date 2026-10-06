// Test : npx tsx tests/vst3state.test.ts : codec de l'état Blue Cat's, vérifié sur un vrai projet Carla.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBlueCatState, juceDecode, juceEncode, parseBlueCatState } from '../src/lib/vst3state';
import { importCarxp } from '../src/lib/carxp';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const xml = readFileSync('tests/fixtures/bluecat_chaine.carxp', 'utf-8');
const plugins = importCarxp(xml).plugins;
const bc = plugins.filter((p) => p.type === 'VST3');

await test('encodage JUCE : aller-retour sur des octets quelconques (toutes les longueurs)', () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 255);
    assert.deepEqual([...juceDecode(juceEncode(b))], [...b], `longueur ${n}`);
  }
  assert.equal(juceEncode(new Uint8Array([0, 0, 0])), '3.....');
  assert.throws(() => juceDecode('pas valide'));
  assert.throws(() => juceDecode('3.é'));
});
await test('projet réel : 3 plugins Blue Cat\'s reconnus, avec le NOM du preset et son chemin', () => {
  assert.equal(bc.length, 3);
  const states = bc.map((p) => ({ n: p.name, s: parseBlueCatState(p.chunk!) }));
  assert.ok(states.every((x) => x.s), 'format reconnu pour les trois');
  const by = (frag: string) => states.find((x) => x.n.includes(frag))!.s!;
  assert.equal(by('Axiom').progName, 'Modu Smooth Delay');
  assert.equal(by('Axiom').presetPath, 'Factory Presets/Guitar - Clean + FX/Modu Smooth Delay.preset');
  assert.equal(by('Dynamics').progName, 'Full Mix Glue [snk]');
  assert.equal(by('MB-7').progName, 'EQ - 7 Bands (MS)');
  assert.equal(by('MB-7').presetPath, 'Factory Presets/EQ & Filter/EQ - 7 Bands (MS).preset', '&amp; est lu comme &');
});
await test('PREUVE : décoder puis ré-encoder redonne EXACTEMENT les mêmes octets que Carla (3 plugins, jusqu\'à 460 Ko)', () => {
  for (const p of bc) {
    const s = parseBlueCatState(p.chunk!)!;
    const rebuilt = buildBlueCatState(s.presetXml);
    assert.equal(rebuilt.length, p.chunk!.replace(/\s+/g, '').length, `${p.name} : même longueur`);
    assert.equal(rebuilt, p.chunk!.replace(/\s+/g, ''), `${p.name} : identique octet pour octet`);
  }
});
await test('formats non reconnus : VST2 (LoopRecorder), texte quelconque → null, jamais d\'exception', () => {
  const lr = plugins.find((p) => p.type === 'VST2')!;
  assert.equal(parseBlueCatState(lr.chunk!), null);
  assert.equal(parseBlueCatState('AAAA'), null); assert.equal(parseBlueCatState(''), null); assert.equal(parseBlueCatState('%%%pas du base64%%%'), null);
});
console.log(`\n${ok} tests réussis`);
