// Test : npx tsx tests/rig.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportCarxp, importCarxp, validateProject, type DbPlugin, type HardwareProfile } from '../src/lib/carxp';
import { buildCatalog, chainToProject, parseChain } from '../src/lib/chain';
import { addPlugin, replacePlugin, ensureHardware } from '../src/lib/editor';
import { projectFromCarxp } from '../src/lib/importer';
import { addProposedScenes, applyScene, generateScenes, planSceneFiles, removeScene, sanitizeFileName, saveScene, validateSceneProposals } from '../src/lib/scenes';

const xml = readFileSync('tests/fixtures/bluecat_basse.carxp', 'utf-8');
const blocks = (x: string) => x.match(/<Plugin>[\s\S]*?<\/Plugin>/g) ?? [];
let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };

const P = (type: string, name: string, over: Partial<DbPlugin>): DbPlugin => ({
  type, name, label: name, maker: '', path: `C:\\VST\\${name}.${type === 'VST3' ? 'vst3' : 'dll'}`, uniqueId: type === 'VST2' ? 500 : null,
  category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over });
const DB: DbPlugin[] = [
  P('VST3', 'Guitar Rig 7', { midiIns: 1 }),                                              // p1
  P('VST2', 'Compresseur 1176', {}),                                                       // p2
  P('VST3', 'Mixeur 8 voies', { audioIns: 8, audioOuts: 2 }),                              // p3
  P('VST3', 'Pianoteq 9', { isSynth: true, audioIns: 0, audioOuts: 2, midiIns: 1 }),       // p4
  P('VST2', 'Ketron SD9', { isSynth: true, audioIns: 0, audioOuts: 16, midiIns: 1 }),      // p5
  P('VST3', 'Limiteur Live', {}),                                                          // p6
  P('VST3', 'Ampli Mono', { audioIns: 1, audioOuts: 1 }),                                  // p7
  P('VST3', 'Mixeur 16 voies', { audioIns: 16, audioOuts: 2 }),                            // p8
];
const HW: HardwareProfile = { name: 'carte', audioIn: ['capture_1', 'capture_2'], audioOut: ['playback_1', 'playback_2'], midiIn: ['Capture 1', 'Capture 2'] };
const cat = buildCatalog(DB);
const j = (o: unknown) => parseChain(JSON.stringify(o));
const cab = (from: string, to: string) => ({ from, to });

// ================= 3. rig multi-instruments =================
await test('rig à 3 instruments (guitare, piano, Ketron) vers un mixeur puis un limiteur : accepté sans avertissement', () => {
  const r = chainToProject(j({ name: 'Rig complet', nodes: [
    { id: 'n1', plugin: 'p1' }, { id: 'n2', plugin: 'p2' }, { id: 'n3', plugin: 'p4' }, { id: 'n4', plugin: 'p5' }, { id: 'mix', plugin: 'p3' }, { id: 'n6', plugin: 'p6' }],
    cables: [
      cab('in:capture_1', 'n1:input_1'), cab('in:capture_1', 'n1:input_2'), cab('n1:output_1', 'n2:input_1'), cab('n1:output_2', 'n2:input_2'),
      cab('n2:output_1', 'mix:input_1'), cab('n2:output_2', 'mix:input_2'),
      cab('midi:Capture 1', 'n3:events-in'), cab('n3:output_1', 'mix:input_3'), cab('n3:output_2', 'mix:input_4'),
      cab('midi:Capture 2', 'n4:events-in'), cab('n4:output_1', 'mix:input_5'), cab('n4:output_2', 'mix:input_6'), cab('n4:output_3', 'mix:input_7'), cab('n4:output_4', 'mix:input_8'),
      cab('mix:output_1', 'n6:input_1'), cab('mix:output_2', 'n6:input_2'), cab('n6:output_1', 'out:playback_1'), cab('n6:output_2', 'out:playback_2')] }), cat, HW);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.equal(r.project.nodes.filter((n) => n.kind === 'plugin').length, 6);
  const out = exportCarxp(r.project, true); const conns = importCarxp(out).connections;
  assert.equal(conns.length, 18);
  assert.ok(conns.some(([s, t]) => s === 'Midi Input:Capture 1' && t === 'Pianoteq 9:events-in'));
  assert.ok(conns.some(([s, t]) => s === 'Midi Input:Capture 2' && t === 'Ketron SD9:events-in'), 'deux ports MIDI distincts');
  assert.equal(importCarxp(out).plugins.length, 6);
});
await test('plusieurs sources vers la MÊME entrée (Carla les additionne) : accepté', () => {
  const r = chainToProject(j({ nodes: [{ id: 'n1', plugin: 'p4' }, { id: 'n2', plugin: 'p5' }],
    cables: [cab('midi:Capture 1', 'n1:events-in'), cab('midi:Capture 2', 'n2:events-in'),
      cab('n1:output_1', 'out:playback_1'), cab('n2:output_1', 'out:playback_1'), cab('n1:output_2', 'out:playback_2'), cab('n2:output_2', 'out:playback_2')] }), cat, HW);
  assert.deepEqual(r.errors, []); assert.equal(r.project.cables.length, 6);
});
await test('mixeur à 16 entrées dont 6 reliées : UN avertissement groupé (pas 10 lignes)', () => {
  const r = chainToProject(j({ nodes: [{ id: 'n1', plugin: 'p4' }, { id: 'mix', plugin: 'p8' }],
    cables: [cab('midi:Capture 1', 'n1:events-in'), cab('n1:output_1', 'mix:input_1'), cab('n1:output_2', 'mix:input_2'),
      cab('mix:output_1', 'out:playback_1'), cab('mix:output_2', 'out:playback_2')] }), cat, HW);
  assert.deepEqual(r.errors, []);
  const w = r.warnings.filter((x) => /entrées audio non reliées/.test(x));
  assert.equal(w.length, 1); assert.match(w[0]!, /14 entrées audio non reliées \(input_3 à input_16\)/);
  assert.equal(validateProject(r.project, { requirePluginFiles: true }).filter((i) => /n'est pas reliée/.test(i.message)).length, 0);
});

// ================= 2. remplacer un plugin =================
const chaine = () => chainToProject(j({ name: 'g', nodes: [{ id: 'n1', plugin: 'p1' }, { id: 'n2', plugin: 'p2' }, { id: 'n3', plugin: 'p6' }],
  cables: [cab('in:capture_1', 'n1:input_1'), cab('in:capture_1', 'n1:input_2'), cab('n1:output_1', 'n2:input_1'), cab('n1:output_2', 'n2:input_2'),
    cab('n2:output_1', 'n3:input_1'), cab('n2:output_2', 'n3:input_2'), cab('n3:output_1', 'out:playback_1'), cab('n3:output_2', 'out:playback_2')] }), cat, HW).project;
const byName = (p: ReturnType<typeof chaine>, n: string) => p.nodes.find((x) => x.name === n)!;

await test('remplacer par un plugin compatible : tous les câbles gardés, nom mis à jour', () => {
  const p = chaine(); const comp = byName(p, 'Compresseur 1176');
  const r = replacePlugin(p, comp.id, DB[5]!); // Limiteur Live (2 in / 2 out) à la place du compresseur
  assert.deepEqual(r.dropped, []); assert.equal(r.kept, 4);
  assert.equal(comp.name, 'Limiteur Live 2', 'nom unique (un Limiteur Live existe déjà)');
  assert.equal(p.cables.length, 8);
  assert.deepEqual(validateProject(p, { requirePluginFiles: true }).filter((i) => i.level === 'error'), []);
});
await test('remplacer par un plugin mono : les câbles des ports absents sont abandonnés et listés', () => {
  const p = chaine(); const comp = byName(p, 'Compresseur 1176');
  const r = replacePlugin(p, comp.id, DB[6]!); // Ampli Mono : input_1 / output_1 seulement
  assert.equal(r.kept, 2); assert.equal(r.dropped.length, 2);
  assert.ok(r.dropped.some((d) => /Guitar Rig 7:output_2 → Compresseur 1176:input_2/.test(d)));
  assert.ok(r.dropped.some((d) => /Compresseur 1176:output_2 → Limiteur Live:input_2/.test(d)));
  assert.equal(p.cables.length, 6);
});
await test('remplacer un instrument par un effet : le câble MIDI disparaît ; refus pour une boîte de carte ou le même plugin', () => {
  const p = chainToProject(j({ nodes: [{ id: 'n1', plugin: 'p4' }], cables: [cab('midi:Capture 1', 'n1:events-in'), cab('n1:output_1', 'out:playback_1'), cab('n1:output_2', 'out:playback_2')] }), cat, HW).project;
  const piano = byName(p, 'Pianoteq 9');
  const r = replacePlugin(p, piano.id, DB[1]!); // un compresseur : pas d'entrée MIDI
  assert.equal(r.dropped.length, 1); assert.match(r.dropped[0] ?? '', /Midi Input:Capture 1 → Pianoteq 9:events-in/);
  assert.equal(r.kept, 2, 'les deux sorties audio sont gardées');
});
await test('remplacement : refus pour la carte son et pour le même plugin ; l\'état sauvegardé de l\'ancien plugin n\'est pas transféré', () => {
  const o = projectFromCarxp(xml, [], HW); // plugins du fichier, avec bloc d'origine
  const hw = o.project.nodes.find((n) => n.kind === 'hw-out')!;
  assert.match(replacePlugin(o.project, hw.id, DB[0]!).error ?? '', /Seul un plugin/);
  const loop = o.project.nodes.find((n) => n.name === 'LoopRecorder')!;
  assert.match(replacePlugin(o.project, loop.id, { ...loop.plugin! }).error ?? '', /déjà ce plugin/);
  assert.ok(loop.raw);
  const r = replacePlugin(o.project, loop.id, DB[5]!);
  assert.equal(r.error, undefined); assert.equal(loop.raw, undefined); assert.equal(loop.chunk, undefined);
  const out = exportCarxp(o.project, true);
  assert.equal(blocks(out)[0], blocks(xml)[0]); assert.equal(blocks(out)[2], blocks(xml)[2]);
  assert.match(blocks(out)[1] ?? '', /<Name>Limiteur Live<\/Name>[\s\S]*<Label>Limiteur Live<\/Label>/);
  assert.ok(!blocks(out)[1]!.includes('<Chunk>'));
});

// ================= 1. scènes =================
const ouvert = () => projectFromCarxp(xml, [
  P('VST3', "Blue Cat's Axiom", { path: "C:\\Program Files\\Common Files\\VST3\\Blue Cat's\\BC Axiom VST3.vst3", midiIns: 1 }),
  P('VST2', 'LoopRecorder', { path: 'C:\\Program Files\\VstPlugins\\4drX\\LoopRecorder.dll', uniqueId: 1282364005 }),
  P('VST2', 'TriplePlay', { path: 'C:\\Program Files\\Steinberg\\VstPlugins\\TriplePlay.dll', uniqueId: 1414541633, audioIns: 0, midiIns: 1, isSynth: true }),
], HW).project;

await test('scènes : enregistrer l\'état (contournements + câblage), le défaire, le réappliquer', () => {
  const p = ouvert(); const loop = p.nodes.find((n) => n.name === 'LoopRecorder')!;
  assert.equal(saveScene(p, 'Complet'), null);
  loop.bypass = true; assert.equal(saveScene(p, 'Sans loop'), null);
  loop.bypass = false;
  assert.equal(p.scenes?.length, 2);
  assert.equal(applyScene(p, p.scenes![1]!.id).ignored, 0); assert.equal(loop.bypass, true);
  applyScene(p, p.scenes![0]!.id); assert.equal(loop.bypass, false);
  assert.equal(saveScene(p, 'sans LOOP'), null); assert.equal(p.scenes?.length, 2, 'même nom (casse ignorée) = remplacement');
  removeScene(p, p.scenes![0]!.id); assert.equal(p.scenes?.length, 1);
  assert.match(saveScene(p, '  ') ?? '', /nom/);
  assert.match(saveScene({ nodes: [], cables: [], hardware: HW }, 'x') ?? '', /aucun plugin/);
});
await test('scènes : une variante de câblage se restaure ; une scène dont un plugin a été supprimé ignore ses câbles orphelins', () => {
  const p = ouvert();
  saveScene(p, 'Tout');
  const n = p.cables.length;
  p.cables = p.cables.filter((c) => !(c.fromPort === 'output_2')); // un autre câblage
  saveScene(p, 'Mono');
  assert.ok(p.cables.length < n);
  applyScene(p, p.scenes![0]!.id); assert.equal(p.cables.length, n);
  const tp = p.nodes.find((x) => x.name === 'TriplePlay')!;
  p.nodes = p.nodes.filter((x) => x.id !== tp.id); p.cables = p.cables.filter((c) => c.fromNode !== tp.id);
  const r = applyScene(p, p.scenes![0]!.id);
  assert.equal(r.ignored, 3); assert.equal(p.cables.length, n - 3);
  assert.match(applyScene(p, 'inconnue').error ?? '', /introuvable/);
});
await test('export des scènes : un .carxp par scène, noms de fichiers sûrs et uniques, patchbay actuel intact', () => {
  const p = ouvert(); const loop = p.nodes.find((n) => n.name === 'LoopRecorder')!;
  saveScene(p, 'Clair'); loop.bypass = true; saveScene(p, 'Solo: lead/aigu?'); saveScene(p, 'Solo lead aigu'); loop.bypass = false;
  const before = JSON.stringify(p);
  const files = planSceneFiles(p, 'bluecat_basse');
  assert.deepEqual(files.map((f) => f.fileName), ['bluecat_basse_Clair.carxp', 'bluecat_basse_Solo leadaigu.carxp', 'bluecat_basse_Solo lead aigu.carxp']);
  assert.equal(JSON.stringify(p), before, 'planifier ne modifie pas le patchbay');
  assert.deepEqual(blocks(files[0]!.xml), blocks(xml), 'scène Clair = projet d\'origine');
  assert.equal(blocks(files[1]!.xml)[1], blocks(xml)[1]!.replace('<Active>Yes</Active>', '<Active>No</Active>'));
  assert.equal(blocks(files[1]!.xml)[0], blocks(xml)[0]);
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij'); assert.equal(sanitizeFileName(' ... '), 'scene');
  const dup = ouvert(); saveScene(dup, 'A:B'); saveScene(dup, 'A/B');
  assert.deepEqual(planSceneFiles(dup, 'x').map((f) => f.fileName), ['x_AB.carxp', 'x_AB-2.carxp']);
});
await test('scènes proposées par l\'IA : identifiants inconnus et « tous les instruments contournés » refusés, puis corrigées', async () => {
  const p = ouvert(); const ids = p.nodes.filter((n) => n.kind === 'plugin').map((n) => n.id);
  const tp = p.nodes.find((n) => n.name === 'TriplePlay')!.id;
  const rep = [
    JSON.stringify({ scenes: [{ name: 'Clair', bypass: ['n99'] }] }),
    JSON.stringify({ scenes: [{ name: 'Muet', bypass: [tp] }] }),
    JSON.stringify({ scenes: [{ name: 'Clair', bypass: [ids[1]], why: 'sans effet' }, { name: 'Boucle', bypass: [] }], notes: ['Changez de scène entre deux morceaux'] }),
  ];
  const vus: string[][] = [];
  const o = await generateScenes(async (_s, m) => { vus.push(m.map((x) => x.content)); return rep.shift() ?? ''; }, 'clair et boucle', p, () => undefined);
  assert.equal(o.ok, true); assert.equal(o.attempts, 3);
  assert.match(vus[0]![0]!, /n1 \| Blue Cat's Axiom \| effet \| VST3/); assert.match(vus[0]![0]!, /n3 \| TriplePlay \| instrument/);
  assert.match(vus[1]![2]!, /n99/); assert.match(vus[2]![4]!, /tous les instruments/);
  assert.equal(addProposedScenes(p, o.scenes!), 2);
  assert.deepEqual(p.scenes!.map((s) => s.name), ['Clair', 'Boucle']);
  assert.equal(p.scenes![0]!.cables.length, p.cables.length);
  const echec = await generateScenes(async () => '{"scenes":[]}', 'x', p, () => undefined);
  assert.equal(echec.ok, false); assert.match(echec.error ?? '', /3 essais/);
  assert.equal((await generateScenes(async () => '{}', 'x', { nodes: [], cables: [], hardware: HW }, () => undefined)).ok, false);
  assert.equal(validateSceneProposals({ scenes: [{ name: 'A', bypass: [] }, { name: 'a', bypass: [] }] }, p).errors.length, 1);
});
console.log(`\n${ok} tests réussis`);
