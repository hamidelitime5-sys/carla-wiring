// Test : npx tsx tests/carxp.test.ts tests/fixtures/bluecat_basse.carxp
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  importCarxp, rewritePatchbay, exportCarxp, validateProject, connectionsOf,
  type PatchProject, type PatchNode, type DbPlugin,
} from '../src/lib/carxp';

const fichier = process.argv[2] ?? 'tests/fixtures/bluecat_basse.carxp';
const xml = readFileSync(fichier, 'utf-8');
let ok = 0;
const test = (nom: string, f: () => void) => { f(); ok++; console.log('  OK  ' + nom); };

const imp = importCarxp(xml);
test('import : 3 plugins lus', () => {
  assert.deepEqual(imp.plugins.map((p) => p.name), ["Blue Cat's Axiom", 'LoopRecorder', 'TriplePlay']);
  assert.equal(imp.plugins[1].uniqueId, 1282364005);
  assert.equal(imp.plugins[0].type, 'VST3');
  assert.equal(imp.bpm, 90);
});
test('import : 9 connexions lues, apostrophes décodées', () => {
  assert.equal(imp.connections.length, 9);
  assert.deepEqual(imp.connections[0], ['Audio Input:Right', "Blue Cat's Axiom:input_1"]);
  assert.deepEqual(imp.connections[6], ['Midi Input:Capture 1', 'TriplePlay:events-in']);
});
test('import : états (Chunk) non vides', () => {
  assert.ok(imp.plugins.every((p) => p.chunk.length > 100));
});

test('réécriture du câblage : plugins et états intacts octet pour octet', () => {
  const nouv = rewritePatchbay(xml, imp.connections.slice(0, 3));
  const avant = xml.slice(0, xml.indexOf('<Patchbay>'));
  const apres = nouv.slice(0, nouv.indexOf('<Patchbay>'));
  assert.equal(apres, avant);
  assert.equal(importCarxp(nouv).connections.length, 3);
  assert.ok(nouv.includes('<ExternalPatchbay>'), 'ExternalPatchbay conservé');
  assert.ok(nouv.includes('<Positions>'), 'positions conservées');
  assert.equal(importCarxp(nouv).plugins[2].chunk, imp.plugins[2].chunk);
});
test('réécriture avec les mêmes connexions : connexions identiques', () => {
  const nouv = rewritePatchbay(xml, imp.connections);
  assert.deepEqual(importCarxp(nouv).connections, imp.connections);
});

// --- Projet construit en mémoire, copie de la structure du fichier de l'utilisateur
const P = (type: string, name: string, path: string, over: Partial<DbPlugin>): DbPlugin => ({
  type, name, label: name, maker: '', path, uniqueId: null, category: '', isSynth: false,
  audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over,
});
const axiom = P('VST3', "Blue Cat's Axiom", "C:\\Program Files\\Common Files\\VST3\\Blue Cat's\\BC Axiom VST3.vst3", { midiIns: 1 });
const loop = P('VST2', 'LoopRecorder', 'C:\\Program Files\\VstPlugins\\4drX\\LoopRecorder.dll', { uniqueId: 1282364005 });
const tp = P('VST2', 'TriplePlay', 'C:\\Program Files\\Steinberg\\VstPlugins\\TriplePlay.dll', { uniqueId: 1414541633, audioIns: 0, midiIns: 1 });
const n = (id: string, kind: PatchNode['kind'], name: string, plugin?: DbPlugin): PatchNode => ({ id, kind, name, plugin, x: 0, y: 0 });
const projet: PatchProject = {
  hardware: { name: 'test', audioIn: ['Left', 'Right'], audioOut: ['Left', 'Right'], midiIn: ['Capture 1'] },
  bpm: 90,
  nodes: [n('in', 'hw-in', 'In'), n('out', 'hw-out', 'Out'), n('mid', 'midi-in', 'Midi'), n('a', 'plugin', axiom.name, axiom), n('l', 'plugin', 'LoopRecorder', loop), n('t', 'plugin', 'TriplePlay', tp)],
  cables: [
    { fromNode: 'in', fromPort: 'Right', toNode: 'a', toPort: 'input_1' },
    { fromNode: 'in', fromPort: 'Right', toNode: 'a', toPort: 'input_2' },
    { fromNode: 'a', fromPort: 'output_1', toNode: 'l', toPort: 'input_1' },
    { fromNode: 'a', fromPort: 'output_2', toNode: 'l', toPort: 'input_2' },
    { fromNode: 'l', fromPort: 'output_1', toNode: 'out', toPort: 'Right' },
    { fromNode: 'l', fromPort: 'output_2', toNode: 'out', toPort: 'Left' },
    { fromNode: 'mid', fromPort: 'Capture 1', toNode: 't', toPort: 'events-in' },
  ],
};
test('validation : le projet de test est valide (aucune erreur)', () => {
  const erreurs = validateProject(projet).filter((i) => i.level === 'error');
  assert.deepEqual(erreurs, []);
});
test('export : les connexions du modèle sont dans le fichier généré, comme dans l\'original', () => {
  const gen = importCarxp(exportCarxp(projet));
  const orig = imp.connections.map((c) => c.join(' -> '));
  for (const c of gen.connections) assert.ok(orig.includes(c.join(' -> ')), 'absent de l\'original : ' + c.join(' -> '));
  assert.equal(gen.plugins.length, 3);
  assert.equal(gen.plugins[1].uniqueId, 1282364005);
  assert.equal(gen.plugins[0].name, "Blue Cat's Axiom");
  assert.equal(gen.bpm, 90);
});
test('export : XML bien équilibré et échappé', () => {
  const x = exportCarxp(projet);
  assert.ok(x.includes('&apos;'));
  assert.equal((x.match(/<Plugin>/g) || []).length, (x.match(/<\/Plugin>/g) || []).length);
  assert.ok(x.startsWith("<?xml version='1.0' encoding='UTF-8'?>"));
  assert.ok(x.includes('<Name>LoopRecorder</Name>'));
});
test('export : chunk repris et bypass', () => {
  const p2: PatchProject = { ...projet, nodes: projet.nodes.map((k) => k.id === 'l' ? { ...k, chunk: imp.plugins[1].chunk, bypass: true } : k) };
  const back = importCarxp(exportCarxp(p2));
  assert.equal(back.plugins[1].chunk, imp.plugins[1].chunk);
  assert.equal(back.plugins[1].active, false);
});

test('validation : câble audio vers MIDI refusé', () => {
  const p2 = { ...projet, cables: [...projet.cables, { fromNode: 'a', fromPort: 'output_1', toNode: 't', toPort: 'events-in' }] };
  assert.ok(validateProject(p2).some((i) => i.level === 'error' && /interdit/.test(i.message)));
});
test('validation : noms en double, port inexistant, plugin hors base, sortie->sortie', () => {
  const dup = { ...projet, nodes: projet.nodes.map((k) => k.id === 't' ? { ...k, name: 'LoopRecorder' } : k) };
  assert.ok(validateProject(dup).some((i) => /uniques/.test(i.message)));
  const port = { ...projet, cables: [...projet.cables, { fromNode: 'a', fromPort: 'output_9', toNode: 'l', toPort: 'input_1' }] };
  assert.ok(validateProject(port).some((i) => /n'existe pas/.test(i.message)));
  const horsBase = { ...projet, nodes: [...projet.nodes, n('x', 'plugin', 'Inconnu')] };
  assert.ok(validateProject(horsBase).some((i) => /pas dans la base/.test(i.message)));
  const so = { ...projet, cables: [...projet.cables, { fromNode: 'a', fromPort: 'output_1', toNode: 'l', toPort: 'output_1' }] };
  assert.ok(validateProject(so).some((i) => i.level === 'error'));
});
test('validation : avertissements (entrée non reliée, nœud isolé)', () => {
  const p2 = { ...projet, cables: projet.cables.filter((c) => c.toPort !== 'input_2' || c.toNode !== 'a'), nodes: [...projet.nodes, n('z', 'plugin', 'Seul', P('VST3', 'Seul', 'C:\\x.vst3', {}))] };
  const w = validateProject(p2).filter((i) => i.level === 'warning').map((i) => i.message);
  assert.ok(w.some((m) => /input_2/.test(m)));
  assert.ok(w.some((m) => /relié à rien/.test(m)));
});
test('connectionsOf : 7 connexions', () => assert.equal(connectionsOf(projet).length, 7));

console.log(`\n${ok} tests réussis`);
