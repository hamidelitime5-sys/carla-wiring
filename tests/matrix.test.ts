// Test : npx tsx tests/matrix.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importCarxp, rewritePatchbay, validateProject, type DbPlugin } from '../src/lib/carxp';
import { buildWiring, parseNames, MAX_OUTPUTS, type PluginRef, type WiringSpec } from '../src/lib/matrix';

let ok = 0;
const test = (nom: string, f: () => void) => { f(); ok++; console.log('  OK  ' + nom); };
const ref = (name: string, ins: number, outs: number, midi: number): PluginRef => ({ name, audioIns: ins, audioOuts: outs, midiIns: midi, midiOuts: 0 });
const hw = (n: number) => Array.from({ length: n }, (_, i) => `playback_${i + 1}`);
const spec = (over: Partial<WiringSpec> & { source: PluginRef }): WiringSpec => ({
  hardware: { audioOut: hw(2), midiPort: 'Capture 1' }, mode: 'fold-stereo', count: 2, midi: { enabled: true }, ...over,
});
const line = (c: [string, string]) => `${c[0]} -> ${c[1]}`;

test('32 sorties une pour une vers une carte à 32 sorties', () => {
  const r = buildWiring(spec({ source: ref('Gros Synthe', 0, 32, 1), mode: 'one-to-one', count: 32, hardware: { audioOut: hw(32), midiPort: 'Capture 1' } }));
  const audio = r.connections.filter((c) => c[0].includes(':output_'));
  assert.equal(audio.length, 32);
  assert.equal(line(audio[0] as [string, string]), 'Gros Synthe:output_1 -> Audio Output:playback_1');
  assert.equal(line(audio[31] as [string, string]), 'Gros Synthe:output_32 -> Audio Output:playback_32');
  assert.deepEqual(validateProject(r.project, { requirePluginFiles: false }).filter((i) => i.level === 'error'), []);
});
test('stéréo : impaires à gauche, paires à droite', () => {
  const r = buildWiring(spec({ source: ref('Batterie', 0, 32, 1), count: 32 }));
  const m = new Map(r.connections.map((c) => [c[0], c[1]]));
  assert.equal(m.get('Batterie:output_1'), 'Audio Output:playback_1');
  assert.equal(m.get('Batterie:output_2'), 'Audio Output:playback_2');
  assert.equal(m.get('Batterie:output_31'), 'Audio Output:playback_1');
  assert.equal(m.get('Batterie:output_32'), 'Audio Output:playback_2');
});
test('une pour une avec une carte de 2 sorties : avertissement, pas de câble hors carte', () => {
  const r = buildWiring(spec({ source: ref('X', 0, 8, 0), mode: 'one-to-one', count: 8, midi: { enabled: false } }));
  assert.equal(r.connections.length, 2);
  assert.ok(r.warnings.some((w) => /2 sortie/.test(w)));
});
test('limites : plus de 32 demandées, plus que le plugin n\'en a', () => {
  const a = buildWiring(spec({ source: ref('X', 0, 64, 0), count: 40, midi: { enabled: false } }));
  assert.equal(a.wired, MAX_OUTPUTS);
  assert.ok(a.warnings.some((w) => /Maximum 32/.test(w)));
  const b = buildWiring(spec({ source: ref('X', 0, 16, 0), count: 32, midi: { enabled: false } }));
  assert.equal(b.wired, 16);
  assert.ok(b.warnings.some((w) => /16 sortie/.test(w)));
  const c = buildWiring(spec({ source: ref('Muet', 2, 0, 0), count: 2, midi: { enabled: false } }));
  assert.equal(c.wired, 0);
  assert.ok(c.warnings.some((w) => /aucune sortie/.test(w)));
});
test('vers un mixeur : 16 entrées, les sorties au-delà sont signalées, sorties du mixeur vers la carte', () => {
  const r = buildWiring(spec({ source: ref('Ketron', 0, 32, 1), mode: 'to-mixer', count: 32, mixer: ref('A-Console', 16, 2, 0) }));
  assert.equal(r.connections.filter((c) => c[1].startsWith('A-Console:input_')).length, 16);
  assert.ok(r.warnings.some((w) => /17 à 32/.test(w)));
  assert.deepEqual(r.connections.filter((c) => c[0].startsWith('A-Console:output_')).map(line),
    ['A-Console:output_1 -> Audio Output:playback_1', 'A-Console:output_2 -> Audio Output:playback_2']);
  assert.deepEqual(validateProject(r.project, { requirePluginFiles: false }).filter((i) => i.level === 'error'), []);
  const same = buildWiring(spec({ source: ref('M', 0, 2, 0), mode: 'to-mixer', mixer: ref('M', 2, 2, 0) }));
  assert.ok(same.warnings.some((w) => /même nom/.test(w)));
});
test('MIDI : port matériel vers events-in, avertissement si le plugin n\'a pas d\'entrée MIDI', () => {
  const r = buildWiring(spec({ source: ref('Kontakt 7', 0, 2, 1) }));
  assert.ok(r.connections.some((c) => line(c) === 'Midi Input:Capture 1 -> Kontakt 7:events-in'));
  const n = buildWiring(spec({ source: ref('Effet', 2, 2, 0) }));
  assert.ok(!n.connections.some((c) => c[1].endsWith(':events-in')));
  assert.ok(n.warnings.some((w) => /pas d'entrée MIDI/.test(w)));
});
test('universel : n\'importe quel nom de plugin, apostrophes comprises', () => {
  for (const nom of ["Blue Cat's Axiom", 'Omnisphere', 'Kontakt 7', 'EZdrummer 3', 'Ma suite de synthés']) {
    const r = buildWiring(spec({ source: ref(nom, 0, 2, 1) }));
    assert.ok(r.connections.every((c) => c[0].startsWith(nom + ':') || c[0].startsWith('Midi Input:') || c[0].startsWith('Audio Output:')));
    assert.equal(r.connections.length, 3);
  }
});
test('de bout en bout : réécriture du câblage dans le vrai projet de l\'utilisateur', () => {
  const xml = readFileSync('tests/fixtures/bluecat_basse.carxp', 'utf-8');
  const before = importCarxp(xml);
  const r = buildWiring(spec({ source: ref("Blue Cat's Axiom", 2, 2, 1), hardware: { audioOut: ['Left', 'Right'], midiPort: 'Capture 1' } }));
  const out = rewritePatchbay(xml, r.connections);
  const after = importCarxp(out);
  assert.deepEqual(after.connections, r.connections);
  assert.equal(after.plugins.length, 3);
  assert.deepEqual(after.plugins.map((p) => p.chunk), before.plugins.map((p) => p.chunk), 'états des plugins intacts');
  assert.ok(out.includes('<ExternalPatchbay>'));
});
test('un nouveau projet exige chemin et identifiant (plugin sans fichier = erreur)', () => {
  const r = buildWiring(spec({ source: ref('Sans fichier', 0, 2, 1) }));
  assert.ok(validateProject(r.project, { requirePluginFiles: true }).some((i) => i.level === 'error' && /chemin/.test(i.message)));
  const db: DbPlugin = { type: 'VST2', name: 'Avec fichier', label: '', maker: '', path: 'C:\\x.dll', uniqueId: 42, category: '', isSynth: true, audioIns: 0, audioOuts: 2, midiIns: 1, midiOuts: 0 };
  const r2 = buildWiring(spec({ source: ref('Avec fichier', 0, 2, 1) }), db);
  assert.deepEqual(validateProject(r2.project, { requirePluginFiles: true }).filter((i) => i.level === 'error'), []);
});
test('parseNames', () => assert.deepEqual(parseNames(' a, b\nc;;\n  '), ['a', 'b', 'c']));

console.log(`\n${ok} tests réussis`);
