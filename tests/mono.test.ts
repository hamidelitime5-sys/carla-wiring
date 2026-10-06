// Test : npx tsx tests/mono.test.ts : plugin à UNE sortie audio (ReValver) → son des deux côtés de la carte son.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalog, chainToProject, generateChain, parseChain, systemPrompt } from '../src/lib/chain';
import { connectionsOf, validateProject, type DbPlugin, type HardwareProfile } from '../src/lib/carxp';
import { addPlugin, connect, emptyProject, ensureHardware, fanOutMono } from '../src/lib/editor';
import { projectFromCarxp } from '../src/lib/importer';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const P = (name: string, over: Partial<DbPlugin>): DbPlugin => ({ type: 'VST3', name, label: name, maker: '', path: `C:\\VST\\${name}.vst3`, uniqueId: null, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over });
const HW: HardwareProfile = { name: 'c', audioIn: ['capture_1', 'capture_2'], audioOut: ['playback_1', 'playback_2'], midiIn: [] };
const RV = P('ReValver', { audioIns: 1, audioOuts: 1 });
const setup = () => {
  const p = emptyProject(HW); const rv = addPlugin(p, RV); const i = ensureHardware(p, 'hw-in'); const o = ensureHardware(p, 'hw-out');
  connect(p, { node: i.id, port: 'capture_1' }, { node: rv.id, port: 'input_1' }); connect(p, { node: rv.id, port: 'output_1' }, { node: o.id, port: 'playback_1' });
  return { p, rv, i, o };
};
const toOut = (p: ReturnType<typeof emptyProject>, port: string) => p.cables.filter((c) => c.toPort === port).length;

await test('plugin mono relié à un seul côté de la carte son : la même sortie est reliée aux DEUX côtés', () => {
  const { p } = setup();
  assert.ok(validateProject(p).some((x) => /ReValver.*n'a qu'une sortie audio \(mono\).*« playback_2 » reste muette/.test(x.message)), 'avertissement');
  assert.equal(fanOutMono(p), 1); assert.equal(toOut(p, 'playback_1'), 1); assert.equal(toOut(p, 'playback_2'), 1);
  assert.equal(p.cables.filter((c) => c.fromPort === 'output_1').length, 2, 'une seule sortie, deux câbles');
  assert.ok(!validateProject(p).some((x) => /mono/.test(x.message)), 'plus d\'avertissement');
  assert.equal(fanOutMono(p), 0, 'idempotent');
});
await test('cas où il ne faut RIEN faire : plugin stéréo, autre signal déjà sur l\'autre côté, une seule entrée en face', () => {
  const st = emptyProject(HW); const a = addPlugin(st, P('Stéréo')); const o = ensureHardware(st, 'hw-out'); connect(st, { node: a.id, port: 'output_1' }, { node: o.id, port: 'playback_1' });
  assert.equal(fanOutMono(st), 0, 'deux sorties : à l\'utilisateur de câbler output_2'); assert.ok(!validateProject(st).some((x) => /mono/.test(x.message)));
  const { p, o: out } = setup(); const autre = addPlugin(p, P('Autre')); connect(p, { node: autre.id, port: 'output_1' }, { node: out.id, port: 'playback_2' });
  assert.equal(fanOutMono(p), 0, 'playback_2 est déjà alimentée par un autre plugin');
  const q = emptyProject(HW); const rv = addPlugin(q, RV); const mono = addPlugin(q, P('Mono entrée', { audioIns: 1, audioOuts: 1 })); connect(q, { node: rv.id, port: 'output_1' }, { node: mono.id, port: 'input_1' });
  assert.equal(fanOutMono(q), 0, 'une seule entrée en face');
});
await test('destination à 4 entrées (chaîne latérale) : seules les deux premières sont alimentées, jamais les entrées 3 et 4', () => {
  const p = emptyProject(HW); const rv = addPlugin(p, RV); const comp = addPlugin(p, P('Compresseur', { audioIns: 4, audioOuts: 2 }));
  connect(p, { node: rv.id, port: 'output_1' }, { node: comp.id, port: 'input_1' });
  assert.equal(fanOutMono(p), 1);
  assert.deepEqual(p.cables.map((c) => c.toPort).sort(), ['input_1', 'input_2']);
});
await test('VOTRE projet revalver5.carxp : output_1 → Left ET Right ; défaire un côté puis « mono → stéréo » le rétablit exactement', () => {
  const xml = readFileSync('tests/fixtures/revalver5.carxp', 'utf-8');
  const hw: HardwareProfile = { name: 'c', audioIn: ['Left', 'Right'], audioOut: ['Left', 'Right'], midiIn: [] };
  const db = [P('ReValver', { path: 'C:\\Program Files\\Common Files\\VST3\\ReValver x64.vst3', audioIns: 1, audioOuts: 1 })];
  const { project } = projectFromCarxp(xml, db, hw);
  const original = connectionsOf(project).sort();
  assert.deepEqual(original, ['Audio Input:Right|ReValver:input_1', 'ReValver:output_1|Audio Output:Left', 'ReValver:output_1|Audio Output:Right'].map((s) => s.split('|') as [string, string]).sort());
  assert.equal(fanOutMono(project), 0, 'déjà correct'); assert.ok(!validateProject(project, { requirePluginFiles: false }).some((x) => /mono/.test(x.message)));
  const idx = project.cables.findIndex((c) => c.toPort === 'Left'); project.cables.splice(idx, 1);
  assert.ok(validateProject(project, { requirePluginFiles: false }).some((x) => /« Left » reste muette/.test(x.message)));
  assert.equal(fanOutMono(project), 1); assert.deepEqual(connectionsOf(project).sort(), original);
});
await test('assistant IA : un plugin mono relié à playback_1 seulement est corrigé avant d\'être rendu (et la règle est dans les consignes)', async () => {
  assert.match(systemPrompt(), /UNE sortie audio \(mono\)/);
  const db = [P('Ampli', { audioIns: 1, audioOuts: 1 }), P('Compresseur', {})];
  const rep = JSON.stringify({ name: 'g', nodes: [{ id: 'n1', plugin: 'p1' }, { id: 'n2', plugin: 'p2' }],
    cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'n2:input_1' }, { from: 'n2:output_1', to: 'out:playback_1' }, { from: 'n2:output_2', to: 'out:playback_2' }] });
  const logs: string[] = []; const o = await generateChain(async () => rep, 'guitare', db, HW, (l) => logs.push(l));
  assert.equal(o.ok, true, o.error);
  const pr = o.result!.project; const cp = pr.nodes.find((n) => n.name === 'Compresseur')!; const am = pr.nodes.find((n) => n.name === 'Ampli')!;
  assert.equal(pr.cables.filter((c) => c.fromNode === am.id).length, 2, 'la sortie mono de l\'ampli alimente input_1 ET input_2 du compresseur');
  assert.ok(logs.some((l) => /1 câble\(s\) ajouté\(s\)/.test(l)), logs.join(' / ')); void cp; void buildCatalog; void chainToProject; void parseChain;
});
console.log(`\n${ok} tests réussis`);
