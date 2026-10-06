// Test : npx tsx tests/open.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportCarxp, importCarxp, validateProject, type DbPlugin, type HardwareProfile } from '../src/lib/carxp';
import { projectFromCarxp, splitProject, matchDb } from '../src/lib/importer';
import { addPlugin, connect, removeNode } from '../src/lib/editor';
import { buildCatalog, describeProject, generateChain, inheritFrom, type AskFn } from '../src/lib/chain';
import { chainSheet } from '../src/lib/sheet';
import { History } from '../src/lib/history';
import { duplicateChain, importChains, loadChain, parseLibrary, removeChain, saveChain, serializeLibrary } from '../src/lib/library';

const xml = readFileSync('tests/fixtures/bluecat_basse.carxp', 'utf-8');
let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const blocks = (x: string) => x.match(/<Plugin>[\s\S]*?<\/Plugin>/g) ?? [];

const P = (type: string, name: string, path: string, over: Partial<DbPlugin>): DbPlugin => ({
  type, name, label: name, maker: '', path, uniqueId: null, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over });
const DB: DbPlugin[] = [
  P('VST3', "Blue Cat's Axiom", "C:\\Program Files\\Common Files\\VST3\\Blue Cat's\\BC Axiom VST3.vst3", { midiIns: 1 }),
  P('VST2', 'LoopRecorder', 'C:\\Program Files\\VstPlugins\\4drX\\LoopRecorder.dll', { uniqueId: 1282364005 }),
  P('VST2', 'TriplePlay', 'C:\\Program Files\\Steinberg\\VstPlugins\\TriplePlay.dll', { uniqueId: 1414541633, audioIns: 0, midiIns: 1, isSynth: true }),
  P('VST3', 'Limiteur Live', 'C:\\VST3\\Limiteur Live.vst3', {}),
];
const HW: HardwareProfile = { name: 'carte', audioIn: ['capture_1', 'capture_2'], audioOut: ['playback_1', 'playback_2'], midiIn: ['Capture 1'] };

await test('découpage : en-tête, 3 blocs de plugins, fin du fichier avec ExternalPatchbay', () => {
  const sp = splitProject(xml);
  assert.equal(sp.plugins.length, 3);
  assert.match(sp.base.head, /<EngineSettings>[\s\S]*<BeatsPerMinute>90<\/BeatsPerMinute>/);
  assert.ok(!sp.base.head.includes('<Plugin>'));
  assert.match(sp.base.tail, /<ExternalPatchbay>[\s\S]*<\/CARLA-PROJECT>/);
  assert.ok(!sp.base.tail.includes('<Patchbay>'));
  assert.match(sp.base.hwPositions, /<Name>Midi Input<\/Name>/);
  assert.match(sp.base.hwPositions, /<Name>Audio Output<\/Name>/);
  assert.deepEqual(sp.plugins, blocks(xml));
});
await test('ouverture avec la base : 3 plugins + 3 nœuds carte, 9 câbles, ports de la carte repris du projet', () => {
  const r = projectFromCarxp(xml, DB, HW);
  assert.equal(r.project.nodes.filter((n) => n.kind === 'plugin').length, 3);
  assert.deepEqual(r.project.nodes.filter((n) => n.kind !== 'plugin').map((n) => n.kind).sort(), ['hw-in', 'hw-out', 'midi-in']);
  assert.equal(r.project.cables.length, 9);
  assert.deepEqual(r.hardware.audioIn, ['Right']);
  assert.deepEqual(r.hardware.audioOut, ['Right', 'Left']);
  assert.deepEqual(r.hardware.midiIn, ['Capture 1']);
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.project.nodes.every((n) => Number.isFinite(n.x)));
  assert.deepEqual(validateProject(r.project, { requirePluginFiles: true }).filter((i) => i.level === 'error'), []);
});
await test('enregistrer sans rien changer : plugins, réglages, en-tête et fin du fichier IDENTIQUES', () => {
  const r = projectFromCarxp(xml, DB, HW);
  const out = exportCarxp(r.project, true);
  assert.deepEqual(blocks(out), blocks(xml), 'blocs de plugins identiques octet pour octet');
  assert.ok(out.startsWith(splitProject(xml).base.head), 'en-tête identique');
  assert.ok(out.includes(splitProject(xml).base.tail.trim()), 'ExternalPatchbay et fin identiques');
  assert.deepEqual(importCarxp(out).connections, importCarxp(xml).connections, 'mêmes câbles, même ordre');
  assert.match(out, /<Name>Midi Input<\/Name>/, 'positions de la carte conservées');
  assert.equal((out.match(/<\/CARLA-PROJECT>/g) ?? []).length, 1);
  assert.equal((out.match(/<Patchbay>/g) ?? []).length, 1);
});
await test('contourner un plugin ne change QUE son <Active>', () => {
  const r = projectFromCarxp(xml, DB, HW);
  const loop = r.project.nodes.find((n) => n.name === 'LoopRecorder');
  assert.ok(loop); loop.bypass = true;
  const out = blocks(exportCarxp(r.project, true));
  const orig = blocks(xml);
  assert.equal(out[1], orig[1]?.replace('<Active>Yes</Active>', '<Active>No</Active>'));
  assert.equal(out[0], orig[0]); assert.equal(out[2], orig[2]);
  assert.equal(importCarxp(exportCarxp(r.project, true)).plugins[1]?.active, false);
});
await test('supprimer un plugin retire son bloc et ses câbles ; les autres restent intacts', () => {
  const r = projectFromCarxp(xml, DB, HW);
  removeNode(r.project, r.project.nodes.find((n) => n.name === 'TriplePlay')!.id);
  const out = exportCarxp(r.project, true);
  assert.deepEqual(blocks(out), [blocks(xml)[0], blocks(xml)[1]]);
  assert.equal(importCarxp(out).connections.length, 6);
  assert.deepEqual([...out.matchAll(/pluginId="(\d+)"/g)].map((m) => m[1]), ['0', '1'], 'positions renumérotées');
});
await test('ajouter un plugin de la base : nouveau bloc ajouté, les anciens intacts ; nouveau câble écrit', () => {
  const r = projectFromCarxp(xml, DB, HW);
  const lim = addPlugin(r.project, DB[3]!);
  const loop = r.project.nodes.find((n) => n.name === 'LoopRecorder')!;
  const out1 = r.project.nodes.find((n) => n.kind === 'hw-out')!;
  const e1 = connect(r.project, { node: loop.id, port: 'output_1' }, { node: lim.id, port: 'input_1' });
  assert.equal(e1, null);
  assert.equal(connect(r.project, { node: lim.id, port: 'output_1' }, { node: out1.id, port: 'Left' }), null);
  const out = exportCarxp(r.project, true);
  assert.equal(blocks(out).length, 4);
  assert.deepEqual(blocks(out).slice(0, 3), blocks(xml));
  assert.match(blocks(out)[3] ?? '', /<Name>Limiteur Live<\/Name>[\s\S]*<Label>Limiteur Live<\/Label>/);
  assert.ok(importCarxp(out).connections.some(([s, t]) => s === 'LoopRecorder:output_1' && t === 'Limiteur Live:input_1'));
  assert.deepEqual(validateProject(r.project, { requirePluginFiles: true }).filter((i) => i.level === 'error'), []);
});
await test('base de plugins vide : ports déduits des câbles, avertissements, enregistrement quand même possible', () => {
  const r = projectFromCarxp(xml, [], HW);
  assert.equal(r.unmatched.length, 3);
  const ax = r.project.nodes.find((n) => n.name === "Blue Cat's Axiom")?.plugin;
  assert.deepEqual([ax?.audioIns, ax?.audioOuts, ax?.midiIns], [2, 2, 0]);
  const tp = r.project.nodes.find((n) => n.name === 'TriplePlay')?.plugin;
  assert.deepEqual([tp?.audioIns, tp?.audioOuts, tp?.midiIns], [0, 2, 1]);
  assert.equal(r.warnings.filter((w) => /n'est pas dans votre base/.test(w)).length, 3);
  assert.deepEqual(validateProject(r.project, { requirePluginFiles: true }).filter((i) => i.level === 'error'), []);
  assert.deepEqual(blocks(exportCarxp(r.project, true)), blocks(xml));
});
await test('rapprochement avec la base : par chemin (casse et / \\ ignorés), sinon par nom', () => {
  assert.equal(matchDb(DB, { binary: 'c:/program files/vstplugins/4drx/looprecorder.dll', name: 'x', type: 'VST2' })?.name, 'LoopRecorder');
  assert.equal(matchDb(DB, { binary: '', name: 'TriplePlay', type: 'VST2' })?.name, 'TriplePlay');
  assert.equal(matchDb(DB, { binary: 'Z:\\autre.dll', name: 'Inconnu', type: 'VST2' }), undefined);
});
await test('extrémité inconnue dans un câble : ignorée avec avertissement, rien ne plante', () => {
  const bad = xml.replace('<Source>Audio Input:Right</Source>', '<Source>Plugin Fantôme:output_1</Source>');
  const r = projectFromCarxp(bad, DB, HW);
  assert.equal(r.project.cables.length, 8, 'un seul des deux câbles de cette entrée était modifié');
  assert.ok(r.warnings.some((w) => /Fantôme/.test(w)));
  const vide = projectFromCarxp("<?xml version='1.0'?>\n<CARLA-PROJECT VERSION='2.5'>\n</CARLA-PROJECT>\n", DB, HW);
  assert.ok(vide.warnings.some((w) => /ni plugin ni câble/.test(w)));
  assert.match(exportCarxp(vide.project, true), /<Patchbay>[\s\S]*<\/CARLA-PROJECT>/);
});

// ----- l'IA modifie la chaîne actuelle
const idOf = (cat: ReturnType<typeof buildCatalog>, name: string) => [...cat.byId].find(([, p]) => p.name === name)?.[0] ?? '?';
await test('IA : chaîne actuelle décrite à l\'IA, plugins conservés = mêmes réglages, nouveau plugin ajouté', async () => {
  const r = projectFromCarxp(xml, DB, HW);
  const cat = buildCatalog(DB);
  const d = describeProject(r.project, cat);
  assert.deepEqual(d.unknown, []);
  assert.match(d.json, new RegExp(`"plugin": "${idOf(cat, 'TriplePlay')}"`));
  const ax = idOf(cat, "Blue Cat's Axiom"), lr = idOf(cat, 'LoopRecorder'), lim = idOf(cat, 'Limiteur Live');
  const proposition = JSON.stringify({ name: 'Basse + limiteur', summary: 'Ajout du limiteur.', notes: ['ok'], missing: [],
    nodes: [{ id: 'n1', plugin: ax }, { id: 'n2', plugin: lr }, { id: 'n9', plugin: lim }],
    cables: [{ from: 'in:Right', to: 'n1:input_1' }, { from: 'in:Right', to: 'n1:input_2' }, { from: 'n1:output_1', to: 'n2:input_1' }, { from: 'n1:output_2', to: 'n2:input_2' },
      { from: 'n2:output_1', to: 'n9:input_1' }, { from: 'n2:output_2', to: 'n9:input_2' }, { from: 'n9:output_1', to: 'out:Right' }, { from: 'n9:output_2', to: 'out:Left' }] });
  let prompt = '';
  const ask: AskFn = async (_s, msgs) => { prompt = msgs[0]?.content ?? ''; return proposition; };
  const o = await generateChain(ask, 'ajoute un limiteur en fin de chaîne', DB, r.hardware, () => undefined, r.project);
  assert.equal(o.ok, true, o.error);
  assert.match(prompt, /MODIFICATION DEMANDÉE : ajoute un limiteur/);
  assert.match(prompt, /CHAÎNE ACTUELLE/);
  const p = o.result!.project;
  const out = exportCarxp(p, true);
  assert.deepEqual(blocks(out).slice(0, 2), [blocks(xml)[0], blocks(xml)[1]], 'Axiom et LoopRecorder gardent leurs blocs d\'origine');
  assert.equal(blocks(out).length, 3);
  assert.match(blocks(out)[2] ?? '', /Limiteur Live/);
  assert.ok(out.startsWith(splitProject(xml).base.head) && out.includes('<ExternalPatchbay>'), 'en-tête et fin conservés');
  assert.equal(p.meta?.name, 'Basse + limiteur');
});
await test('IA : un plugin du patchbay absent de la base empêche la modification, avec un message clair', async () => {
  const r = projectFromCarxp(xml, DB.slice(0, 2), HW);
  let appels = 0;
  const o = await generateChain(async () => { appels++; return '{}'; }, 'x', DB.slice(0, 2), r.hardware, () => undefined, r.project);
  assert.equal(o.ok, false); assert.match(o.error ?? '', /TriplePlay/); assert.equal(appels, 0);
});
await test('inheritFrom : noms uniques conservés, aucun doublon', () => {
  const a = projectFromCarxp(xml, DB, HW).project;
  const b = projectFromCarxp(xml, DB, HW).project;
  const extra = addPlugin(b, DB[1]!); // un 2e LoopRecorder « nouveau »
  inheritFrom(b, a);
  const names = b.nodes.filter((n) => n.kind === 'plugin').map((n) => n.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.ok(extra.name !== 'LoopRecorder' || b.nodes.filter((n) => n.name === 'LoopRecorder').length === 1);
});

// ----- bibliothèque, historique, fiche
await test('Mes chaînes : enregistrer, remplacer, dupliquer, charger (copie), supprimer, échanger par fichier', () => {
  const proj = projectFromCarxp(xml, DB, HW).project;
  let lib = saveChain([], 'Basse live', proj, new Date('2026-10-04T10:00:00Z'));
  lib = saveChain(lib, 'Autre', proj);
  assert.equal(lib.length, 2);
  lib = saveChain(lib, 'basse LIVE', { ...proj, cables: [] });
  assert.equal(lib.length, 2, 'même nom (sans tenir compte de la casse) = remplacement');
  assert.equal(lib[0]?.project.cables.length, 0);
  lib = duplicateChain(lib, lib[0]!.id); lib = duplicateChain(lib, lib[0]!.id);
  assert.deepEqual(lib.map((c) => c.name), ['basse LIVE', 'Autre', 'basse LIVE (copie)', 'basse LIVE (copie 2)']);
  const copie = loadChain(lib, lib[1]!.id)!;
  copie.cables = []; assert.equal(lib[1]?.project.cables.length, 9, 'charger donne une COPIE');
  assert.equal(loadChain(lib, 'inexistant'), null);
  const txt = serializeLibrary(lib);
  const re = importChains(lib, txt);
  assert.equal(re.added, 4); assert.equal(re.list.length, 8);
  assert.equal(new Set(re.list.map((c) => c.name.toLowerCase())).size, 8, 'aucun nom en double');
  assert.equal(new Set(re.list.map((c) => c.id)).size, 8, 'aucun identifiant en double');
  assert.equal(removeChain(lib, lib[0]!.id).length, 3);
  assert.deepEqual(parseLibrary({ chains: [{ name: '', project: {} }, { name: 'ok', project: { nodes: [], cables: [], hardware: {} } }, 12, null] }).map((c) => c.name), ['ok']);
  assert.throws(() => saveChain([], '  ', proj), /nom/);
  assert.throws(() => importChains([], 'pas du json'));
});
await test('annuler / rétablir : états successifs, limite, rétablir effacé par une nouvelle action', () => {
  const h = new History('a');
  assert.equal(h.commit('a'), false);
  h.commit('b'); h.commit('c');
  assert.equal(h.undo(), 'b'); assert.equal(h.undo(), 'a'); assert.equal(h.undo(), null);
  assert.equal(h.redo(), 'b');
  h.commit('d');
  assert.equal(h.canRedo, false); assert.equal(h.redo(), null);
  assert.equal(h.undo(), 'b');
  const petit = new History('0', 3); for (const s of ['1', '2', '3', '4', '5']) petit.commit(s);
  let n = 0; while (petit.undo() !== null) n++;
  assert.equal(n, 3);
});
await test('fiche de concert (Markdown) : plugins dans l\'ordre du signal, câbles, conseils, fichiers', () => {
  const r = projectFromCarxp(xml, DB, HW);
  r.project.meta = { name: 'Basse live', summary: 'Basse propre.', notes: ['Niveau d\'entrée à -12 dB'], missing: ['Un EQ'] };
  r.project.nodes.find((n) => n.name === 'LoopRecorder')!.bypass = true;
  const md = chainSheet(r.project);
  assert.match(md, /^# Basse live/);
  assert.match(md, /\*\*LoopRecorder\*\* _\(contourné\)_/);
  assert.match(md, /- `Audio Input:Right` → `Blue Cat's Axiom:input_1`/);
  assert.match(md, /## Conseils pour le live[\s\S]*Niveau d'entrée/);
  assert.match(md, /## Ce qui manquait[\s\S]*Un EQ/);
  assert.match(md, /## Fichiers des plugins[\s\S]*TriplePlay\.dll/);
  assert.ok(chainSheet({ nodes: [], cables: [], hardware: HW }).includes('_Aucun plugin._'));
});
console.log(`\n${ok} tests réussis`);
