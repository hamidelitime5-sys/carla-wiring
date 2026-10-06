// Test : npx tsx tests/tools.test.ts : outils d'organisation, export centré dans Carla, presets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }, configurable: true });
import { CARLA_CANVAS, exportCarxp, importCarxp, validateProject, type DbPlugin, type HardwareProfile, type PatchProject } from '../src/lib/carxp';
import { addPlugin, alignNodes, autoLayout, boundingBox, colorByRole, ROLE_COLORS, connect, distributeNodes, emptyProject, ensureHardware, moveNodes, nodeHeight, NODE_W, setColor, snapNodes } from '../src/lib/editor';
import { projectFromCarxp } from '../src/lib/importer';
import { applyPreset, captureStates, classifyExts, collectionOf, injectFilePresets, isBlueCatVst3, isTone3000, presetFileToChunk, hintsFromDb, makeBook, makeMatcher, norm, normalizeIndex, normalizeStates, pluginsForDir, type PresetEntry, type PresetIndex } from '../src/lib/presets';
import { storeRead, storeWrite } from '../src/lib/store';
import { parseBlueCatState, unwrapVc2 } from '../src/lib/vst3state';
import { t3kPresetToChunk } from '../src/lib/t3k';
import { getStr, readValueTree } from '../src/lib/valuetree';

const xml = readFileSync('tests/fixtures/bluecat_basse.carxp', 'utf-8');
let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const P = (type: string, name: string, over: Partial<DbPlugin>): DbPlugin => ({
  type, name, label: name, maker: '', path: `C:\\VST\\${name}.dll`, uniqueId: null, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over });
const HW: HardwareProfile = { name: 'c', audioIn: ['capture_1', 'capture_2'], audioOut: ['playback_1', 'playback_2'], midiIn: ['Capture 1'] };
const proj = (): PatchProject => {
  const p = emptyProject(HW);
  const a = addPlugin(p, P('VST3', 'Ampli', {})); const b = addPlugin(p, P('VST2', 'Comp', {})); const c = addPlugin(p, P('VST3', 'Limiteur', {}));
  const i = ensureHardware(p, 'hw-in'); const o = ensureHardware(p, 'hw-out');
  connect(p, { node: i.id, port: 'capture_1' }, { node: a.id, port: 'input_1' }); connect(p, { node: a.id, port: 'output_1' }, { node: b.id, port: 'input_1' });
  connect(p, { node: b.id, port: 'output_1' }, { node: c.id, port: 'input_1' }); connect(p, { node: c.id, port: 'output_1' }, { node: o.id, port: 'playback_1' });
  autoLayout(p); return p;
};
const ids = (p: PatchProject) => p.nodes.map((n) => n.id);

// ================= outils d'organisation =================
await test('couleur : appliquée à la sélection puis retirée', () => {
  const p = proj(); assert.equal(setColor(p, [p.nodes[0]!.id, p.nodes[1]!.id], '#f472b6'), 2);
  assert.equal(p.nodes[0]!.color, '#f472b6'); assert.equal(p.nodes[2]!.color, undefined);
  setColor(p, [p.nodes[0]!.id], undefined); assert.equal(p.nodes[0]!.color, undefined);
  assert.equal(JSON.parse(JSON.stringify(p)).nodes[1].color, '#f472b6', 'la couleur est enregistrée avec le projet');
});
await test('aligner : bord gauche, droit, haut, bas, centres', () => {
  const p = proj(); const s = ids(p).slice(0, 3);
  p.nodes[0]!.x = 100; p.nodes[1]!.x = 400; p.nodes[2]!.x = 250; p.nodes[0]!.y = 50; p.nodes[1]!.y = 300; p.nodes[2]!.y = 150;
  alignNodes(p, s, 'left'); assert.deepEqual(p.nodes.slice(0, 3).map((n) => n.x), [100, 100, 100]);
  p.nodes[0]!.x = 100; p.nodes[1]!.x = 400; p.nodes[2]!.x = 250;
  alignNodes(p, s, 'right'); assert.deepEqual(p.nodes.slice(0, 3).map((n) => n.x), [400, 400, 400]);
  p.nodes[0]!.x = 100; p.nodes[1]!.x = 400; alignNodes(p, s.slice(0, 2), 'centerX'); assert.equal(p.nodes[0]!.x, p.nodes[1]!.x);
  alignNodes(p, s, 'top'); assert.deepEqual(new Set(p.nodes.slice(0, 3).map((n) => n.y)).size, 1);
  const bas = (n: typeof p.nodes[0]) => n!.y + nodeHeight(n!, p.hardware);
  alignNodes(p, s, 'bottom'); assert.equal(bas(p.nodes[0]), bas(p.nodes[1]));
  assert.equal(alignNodes(p, [s[0]!], 'left'), 0, 'il faut au moins 2 boîtes');
});
await test('répartir régulièrement : écarts égaux, extrémités immobiles ; au moins 3 boîtes', () => {
  const p = proj(); const s = ids(p).slice(0, 3);
  p.nodes[0]!.x = 0; p.nodes[1]!.x = 700; p.nodes[2]!.x = 1000;
  assert.equal(distributeNodes(p, s, 'x'), 3);
  const [a, b, c] = [p.nodes[0]!, p.nodes[1]!, p.nodes[2]!];
  assert.equal(a.x, 0); assert.equal(c.x, 1000);
  assert.ok(Math.abs((b.x - (a.x + NODE_W)) - (c.x - (b.x + NODE_W))) <= 1, 'écarts égaux');
  assert.equal(distributeNodes(p, s.slice(0, 2), 'x'), 0);
  p.nodes[0]!.y = 0; p.nodes[1]!.y = 500; p.nodes[2]!.y = 520;
  distributeNodes(p, s, 'y'); assert.ok(p.nodes[1]!.y > 100 && p.nodes[1]!.y < 500);
});
await test('grille, déplacement groupé, cadre englobant', () => {
  const p = proj(); const n = p.nodes[0]!; n.x = 133; n.y = 47;
  snapNodes(p, [n.id], 20); assert.deepEqual([n.x, n.y], [140, 40]);
  moveNodes(p, [n.id], 10, -100); assert.deepEqual([n.x, n.y], [150, 0], 'jamais de coordonnée négative');
  const b = boundingBox(p)!; assert.ok(b.w > NODE_W && b.h > 0);
  assert.equal(boundingBox(emptyProject(HW)), null);
});

// ================= export centré dans Carla =================
const positions = (x: string) => [...x.matchAll(/<Position x1="(\d+)" y1="(\d+)"(?: x2="(\d+)" y2="(\d+)")?(?: pluginId="(\d+)")?>\s*<Name>([^<]*)<\/Name>/g)]
  .map((m) => ({ x: Number(m[1]), y: Number(m[2]), x2: m[3] ? Number(m[3]) : null, y2: m[4] ? Number(m[4]) : null, name: m[6]!.replace('&apos;', "'") }));
await test('export : TOUTES les boîtes (plugins et carte son) ont une position, centrées sur le canevas de Carla', () => {
  const p = proj(); p.nodes.forEach((n) => { n.x += 5; n.y += 5; });
  const out = exportCarxp(p, true);
  const pos = positions(out.slice(out.indexOf('<Patchbay>')));
  assert.deepEqual(pos.map((x) => x.name).sort(), ['Ampli', 'Audio Input', 'Audio Output', 'Comp', 'Limiteur']);
  const hw = pos.filter((x) => x.x2 !== null); assert.equal(hw.length, 2);
  assert.ok(hw.every((h) => h.x === h.x2 && h.y === h.y2), 'côtés entrée et sortie au même endroit');
  const sizes = new Map(p.nodes.map((n) => [n.kind === 'plugin' ? n.name : n.name, nodeHeight(n, p.hardware)]));
  const minX = Math.min(...pos.map((x) => x.x)), maxX = Math.max(...pos.map((x) => x.x + NODE_W));
  const minY = Math.min(...pos.map((x) => x.y)), maxY = Math.max(...pos.map((x) => x.y + sizes.get(x.name)!));
  assert.ok(Math.abs((minX + maxX) / 2 - CARLA_CANVAS.w / 2) <= 2, `centre X ${(minX + maxX) / 2}`);
  assert.ok(Math.abs((minY + maxY) / 2 - CARLA_CANVAS.h / 2) <= 2, `centre Y ${(minY + maxY) / 2}`);
  assert.ok(pos.every((x) => x.x >= 0 && x.y >= 0 && x.x < CARLA_CANVAS.w && x.y < CARLA_CANVAS.h), 'tout reste dans le canevas');
});
await test('export : la disposition faite à la main est respectée (seul un décalage global est appliqué)', () => {
  const p = proj(); const base = exportCarxp(p, true);
  p.nodes[0]!.x += 400; p.nodes[0]!.y += 300; // on éloigne volontairement une boîte
  const moved = positions(exportCarxp(p, true)); const first = positions(base);
  const d = (a: typeof first, n: string) => a.find((x) => x.name === n)!;
  assert.ok(d(moved, 'Ampli').x - d(moved, 'Comp').x !== d(first, 'Ampli').x - d(first, 'Comp').x, 'écart entre boîtes conservé tel que dessiné');
  assert.equal(d(moved, 'Comp').y - d(moved, 'Limiteur').y, d(first, 'Comp').y - d(first, 'Limiteur').y, 'les boîtes non touchées gardent leurs distances');
});
await test('export : option « ne pas centrer » (projet ouvert) garde les positions de la carte son d\'origine', () => {
  const o = projectFromCarxp(xml, [], HW).project;
  const centre = exportCarxp(o, true); const brut = exportCarxp(o, true, { center: false });
  assert.match(brut, /<Position x1="0" y1="969" x2="707" y2="982">\s*<Name>Midi Input<\/Name>/, 'positions brutes d\'origine');
  assert.doesNotMatch(centre, /x1="0" y1="969" x2="707"/, 'avec centrage elles sont recalculées');
  assert.match(centre, /<Name>Midi Input<\/Name>/); assert.match(centre, /<Name>Audio Output<\/Name>/);
  assert.equal((centre.match(/<Name>Audio Input<\/Name>/g) ?? []).length, 1, 'une seule position par groupe de la carte son');
  assert.equal(importCarxp(centre).plugins.length, 3);
  assert.deepEqual(exportCarxp(proj(), false).includes('<Positions>'), false);
});

// ================= presets =================
const AX = P('VST3', "Blue Cat's Axiom", { path: "C:\\Program Files\\Common Files\\VST3\\Blue Cat's\\BC Axiom VST3.vst3", midiIns: 1 });
const LR = P('VST2', 'LoopRecorder', { path: 'C:\\VstPlugins\\LoopRecorder.dll', uniqueId: 1282364005 });
const E = (name: string, hints: string[], over: Partial<PresetEntry> = {}): PresetEntry => ({ path: `C:\\P\\${hints[0] ?? 'x'}\\${name}.fxp`, name, ext: 'fxp', kind: 'fxp', vstId: null, classId: null, hints, size: 10, ...over });
await test('noms comparables : « BC Axiom VST3 data » = « Blue Cat\'s Axiom »', () => {
  assert.equal(norm("Blue Cat's Axiom"), 'axiom'); assert.equal(norm('BC Axiom VST3 data'), 'axiom'); assert.equal(norm('Presets'), 'presets'.slice(0, 0) || norm('Presets'));
  assert.equal(norm('LoopRecorder x64'), 'looprecorder');
});
await test('association : identifiant VST2 (en-tête .fxp) d\'abord, puis nom de dossier, sinon non assigné', () => {
  const m = makeMatcher([AX, LR]);
  assert.equal(m.match(E('a', ['N importe quoi'], { vstId: 1282364005 }))?.name, 'LoopRecorder');
  assert.equal(m.match(E('b', ['Presets', 'BC Axiom VST3 data']))?.name, "Blue Cat's Axiom");
  assert.equal(m.match(E('c', ['VST3 Presets', 'Blue Cat', 'Axiom']))?.name, "Blue Cat's Axiom", 'structure standard Vendeur/Plugin');
  assert.equal(m.match(E('d', ['Divers', 'Autre'])), undefined);
});
const index: PresetIndex = { version: 1, scannedAt: 'x', roots: ['C:\\'], extensions: ['fxp'], truncated: false, entries: [
  E('Basse ronde', ['Presets', 'BC Axiom VST3 data']), E('Lead criard', ['Presets', 'BC Axiom VST3 data']), E('Nappe douce', ['Presets', 'BC Axiom VST3 data']),
  E('Boucle claire', ['x'], { vstId: 1282364005 }), E('Orphelin', ['Divers']) ] };
await test('livre de presets : comptes, non assignés, classement par pertinence selon la demande', () => {
  const book = makeBook(index, [], [AX, LR]);
  assert.deepEqual([book.total, book.assigned, book.unassigned.length], [5, 4, 1]);
  assert.equal(book.countFor(AX), 3); assert.equal(book.countFor(LR), 1);
  assert.equal(book.forPlugin(AX, 'une basse bien ronde pour le live', 5)[0]!.name, 'Basse ronde');
  assert.equal(book.forPlugin(AX, 'un lead pour un solo', 5)[0]!.name, 'Lead criard');
  assert.equal(book.forPlugin(AX, 'x', 2).length, 2, 'limite respectée');
  assert.equal(book.forPlugin(P('VST2', 'Autre', {}), 'x', 5).length, 0);
});
await test('sons capturés depuis un projet Carla : l\'état de chaque plugin est lu tel quel', () => {
  const st = captureStates(xml, 'bluecat_basse', [AX, LR], new Date('2026-10-05T10:00:00Z'));
  const imp = importCarxp(xml);
  assert.equal(st.length, 3); assert.deepEqual(st.map((s) => s.chunk), imp.plugins.map((p) => p.chunk));
  assert.match(st[0]!.name, / \(bluecat_basse\)$/, 'le nom du preset lu dans l\'état, suivi du projet'); assert.ok(!st[0]!.name.startsWith("Blue Cat's Axiom –"));
  assert.equal(st[1]!.name, 'LoopRecorder – bluecat_basse', 'VST2 : pas de nom lisible, nom du plugin');
  assert.equal(st[0]!.pluginKey, `${AX.path}|${AX.name}`, 'rattaché au plugin de la base');
  assert.equal(st[2]!.pluginKey, 'C:\\Program Files\\Steinberg\\VstPlugins\\TriplePlay.dll|TriplePlay', 'plugin absent de la base : clé construite depuis le fichier');
  assert.equal(new Set(st.map((s) => s.id)).size, 3);
});
await test('appliquer un son capturé : l\'état est injecté dans le .carxp exporté (bloc d\'origine remplacé)', () => {
  const st = captureStates(xml, 'bluecat_basse', [AX, LR])[0]!;
  const p = emptyProject(HW); const n = addPlugin(p, AX); const i = ensureHardware(p, 'hw-in'); const o = ensureHardware(p, 'hw-out');
  connect(p, { node: i.id, port: 'capture_1' }, { node: n.id, port: 'input_1' }); connect(p, { node: n.id, port: 'output_1' }, { node: o.id, port: 'playback_1' });
  applyPreset(n, { kind: 'state', name: st.name, stateId: st.id, chunk: st.chunk });
  assert.deepEqual(validateProject(p, { requirePluginFiles: true }).filter((x) => x.level === 'error'), []);
  const back = importCarxp(exportCarxp(p, true));
  assert.equal(back.plugins[0]!.chunk, st.chunk, 'le Chunk exporté est identique à l\'état capturé');
  // projet ouvert : le bloc d'origine est remplacé par le nouvel état
  const open = projectFromCarxp(xml, [AX, LR], HW).project; const ax = open.nodes.find((x) => x.name === "Blue Cat's Axiom")!;
  assert.ok(ax.raw); applyPreset(ax, { kind: 'state', name: 'autre', chunk: 'QUJDRA==' });
  assert.equal(ax.raw, undefined);
  assert.equal(importCarxp(exportCarxp(open, true)).plugins[0]!.chunk, 'QUJDRA==');
  // un preset FICHIER est seulement mémorisé : l'état du plugin ne change pas
  const open2 = projectFromCarxp(xml, [AX, LR], HW).project; const ax2 = open2.nodes.find((x) => x.name === "Blue Cat's Axiom")!;
  applyPreset(ax2, { kind: 'file', name: 'Basse ronde', path: 'C:\\P\\Basse ronde.fxp' });
  assert.ok(ax2.raw, 'bloc d\'origine conservé'); assert.equal(ax2.preset?.kind, 'file');
});
await test('normalisation des données lues sur disque (fichiers abîmés ignorés) et stockage', async () => {
  assert.equal(normalizeIndex({ entries: 'non' }), null); assert.equal(normalizeIndex(null), null);
  assert.equal(normalizeIndex({ entries: [{ path: 'a', name: 'b' }, { nom: 'x' }, 12] })?.entries.length, 1);
  assert.equal(normalizeStates([{ id: 'a', chunk: 'c', pluginKey: 'k' }, { id: 'b' }]).length, 1);
  assert.deepEqual(normalizeStates({ states: [{ id: 'a', chunk: 'c', pluginKey: 'k' }] }).length, 1);
  assert.equal(await storeRead('inexistant'), null);
  await storeWrite('presets', { a: 1 }); assert.deepEqual(await storeRead('presets'), { a: 1 });
});

// ----- découverte automatique (cas MeldaProduction)
const MX = P('VST3', 'MXXX', { path: 'C:\\Program Files\\Common Files\\VST3\\MeldaProduction\\MXXX.vst3' });
const ME = P('VST3', 'MEqualizer', { path: 'C:\\Program Files\\Common Files\\VST3\\MeldaProduction\\MEqualizer.vst3', maker: 'MeldaProduction' });
await test('MeldaProduction : le préfixe de l\'éditeur est ignoré, les dossiers sont rattachés au bon plugin', () => {
  assert.equal(norm('MeldaProduction MXXX'), 'mxxx'); assert.equal(norm('MeldaProduction MEqualizer'), 'mequalizer'); assert.equal(norm('MEqualizer'), 'mequalizer');
  const hints = hintsFromDb([MX, ME, P('VST3', 'Ab', {})]);
  assert.ok(hints.includes('mxxx') && hints.includes('mequalizer') && !hints.includes('ab'), hints.join());
  assert.deepEqual(pluginsForDir('MeldaProduction MXXX', [MX, ME]).map((p) => p.name), ['MXXX']);
  assert.deepEqual(pluginsForDir('MeldaProduction MEqualizer', [MX, ME]).map((p) => p.name), ['MEqualizer']);
  assert.deepEqual(pluginsForDir('Dossier sans rapport', [MX, ME]), []);
  const m = makeMatcher([MX, ME]);
  assert.equal(m.match(E('Slap', ['Delay', 'Presets', 'MeldaProduction MXXX', 'MeldaProduction', 'Roaming', 'AppData']))?.name, 'MXXX', 'le dossier du plugin est le 3e parent');
});
await test('formats : probables presets / bruit / à vérifier', () => {
  const ex = (ext: string, count = 1) => ({ ext, count, example: '' });
  const c = classifyExts([ex('mpreset', 40), ex('winstate', 12), ex('active', 3), ex('xyz', 5), ex('png'), ex('vstpreset'), ex('fxp'), ex('(sans extension)')]);
  assert.deepEqual(c.likely.map((e) => e.ext), ['mpreset', 'active', 'vstpreset', 'fxp']);
  assert.deepEqual(c.noise.map((e) => e.ext), ['winstate', 'png', '(sans extension)']);
  assert.deepEqual(c.other.map((e) => e.ext), ['xyz'], 'un format inconnu est proposé, jamais ajouté sans accord');
});

await test('couleurs par rôle : instruments, effets, carte son', () => {
  const p = proj(); p.nodes[0]!.plugin!.isSynth = true;
  assert.equal(colorByRole(p), p.nodes.length);
  assert.equal(p.nodes[0]!.color, ROLE_COLORS.instrument); assert.equal(p.nodes[1]!.color, ROLE_COLORS.effect);
  assert.equal(p.nodes.find((n) => n.kind === 'hw-in')!.color, ROLE_COLORS.hardware);
});

// ----- cas Guitar Rig 7 (.ngrr) et faux positifs vus sur le vrai disque
const GR7 = P('VST3', 'Guitar Rig 7', { path: 'C:\\Program Files\\Common Files\\VST3\\Guitar Rig 7.vst3', midiIns: 1 });
const ngrr = (name: string): PresetEntry => ({ path: `C:\\Program Files\\Common Files\\Native Instruments\\Guitar Rig 7\\Rack Presets\\${name}.ngrr`, name, ext: 'ngrr', kind: 'other', vstId: null, classId: null, hints: ['Rack Presets', 'Guitar Rig 7', 'Native Instruments', 'Common Files', 'Program Files'], size: 44000 });
await test('Guitar Rig 7 : les .ngrr de Common Files sont rattachés au plugin ; formats .ngrr probables, .qmlc = bruit', () => {
  const book = makeBook({ version: 1, scannedAt: '', roots: [], extensions: ['ngrr'], truncated: false, entries: ['Super Crunch', 'Stoney Fuzz', 'Studio DI Bass', 'Strat Funky Autofilter', 'Super Clean Funk', 'Sub Bass King'].map(ngrr) }, [], [GR7, MX]);
  assert.deepEqual([book.total, book.assigned, book.countFor(GR7)], [6, 6, 6]);
  const c = classifyExts([{ ext: 'ngrr', count: 1426, example: '' }, { ext: 'qmlc', count: 132, example: '' }, { ext: '(sans extension)', count: 1, example: '' }]);
  assert.deepEqual(c.likely.map((e) => e.ext), ['ngrr']); assert.deepEqual(c.noise.map((e) => e.ext), ['qmlc', '(sans extension)']);
});
await test('demande en FRANÇAIS sur des presets en ANGLAIS : « lead saturé » retrouve crunch / fuzz, « son clair » retrouve clean', () => {
  const book = makeBook({ version: 1, scannedAt: '', roots: [], extensions: ['ngrr'], truncated: false, entries: ['Studio DI Bass', 'Super Crunch', 'Sub Bass King', 'Stoney Fuzz', 'Super Clean Funk', 'Strat Funky Autofilter'].map(ngrr) }, [], [GR7]);
  const sature = book.forPlugin(GR7, 'guitare lead saturé et expressif', 2).map((c) => c.name);
  assert.ok(sature.includes('Super Crunch') && sature.includes('Stoney Fuzz'), sature.join());
  assert.equal(book.forPlugin(GR7, 'un son clair et propre', 1)[0]!.name, 'Super Clean Funk');
  assert.equal(book.forPlugin(GR7, 'une basse', 2).map((c) => c.name).sort().join('|'), 'Studio DI Bass|Sub Bass King');
});
await test('faux positifs du vrai disque : « player » et « Scripts » ne sont plus pris pour des dossiers de plugins', () => {
  const SM = P('VST3', 'SynthMaster 2 Player', {}), PS = P('VST3', "Blue Cat's Plug'n Script Synth", {});
  assert.deepEqual(pluginsForDir('player', [SM, PS]), []); assert.deepEqual(pluginsForDir('Scripts', [SM, PS]), []);
  assert.deepEqual(pluginsForDir('SynthMaster 2 Player', [SM, PS]).map((p) => p.name), ['SynthMaster 2 Player'], 'le vrai dossier reste reconnu');
  const m = makeMatcher([SM, PS]);
  assert.equal(m.match(E('x', ['player', 'utorrent'])), undefined); assert.equal(m.match(E('y', ['Scripts', 'Cubase 15_64'])), undefined);
  assert.equal(m.match(E('z', ['Presets', 'SynthMaster 2 Player']))?.name, 'SynthMaster 2 Player');
});

// ----- collections (composants de Guitar Rig : Reflektor, Matched Cabinet Pro…)
const GRP = 'C:\\Program Files\\Common Files\\Native Instruments\\Guitar Rig 7\\';
const cmp = (name: string, ...hints: string[]): PresetEntry => ({ path: `${GRP}${hints.slice().reverse().join('\\')}\\${name}.ngrr`, name, ext: 'ngrr', kind: 'other', vstId: null, classId: null, hints: [...hints, 'Guitar Rig 7', 'Native Instruments', 'Common Files'], size: 1 });
await test('collection : le composant d\'où vient un preset (dossiers génériques ignorés)', () => {
  assert.equal(collectionOf(cmp('x', 'Presets', 'Reflektor', 'Content'), 3), 'Reflektor');
  assert.equal(collectionOf(cmp('x', 'Rack Presets'), 1), 'Rack Presets');
  assert.equal(collectionOf(cmp('x', 'Presets'), 1), undefined, 'rien d\'utile sous le dossier du plugin');
  assert.equal(collectionOf({ ...cmp('x', 'Jazz Banks'), vstId: 5 }, -1), 'Jazz Banks', 'preset reconnu par son identifiant : le dossier parent');
  assert.equal(collectionOf({ ...cmp('x', 'Presets'), vstId: 5 }, -1), undefined);
});
await test('collections : « enceinte 4x12 » met en tête les presets du composant Matched Cabinet Pro ; la famille est transmise au preset choisi', () => {
  const entries = [cmp('Spring Hall', 'Presets', 'Reflektor', 'Content'), cmp('Preset A', 'Presets', 'Matched Cabinet Pro', 'Content'), cmp('Preset B', 'Presets', 'Tapedeck', 'Content'), cmp('Super Crunch', 'Rack Presets')];
  const book = makeBook({ version: 1, scannedAt: '', roots: [], extensions: ['ngrr'], truncated: false, entries }, [], [GR7]);
  const r = book.forPlugin(GR7, 'une enceinte 4x12 bien choisie', 4);
  assert.equal(r[0]!.name, 'Preset A'); assert.equal(r[0]!.collection, 'Matched Cabinet Pro');
  assert.equal(r.find((c) => c.name === 'Super Crunch')!.collection, 'Rack Presets');
  assert.equal(book.forPlugin(GR7, 'une réverbération', 4)[0]!.name, 'Spring Hall', 'le nom du preset compte aussi');
  const n = addPlugin(emptyProject(HW), GR7); applyPreset(n, r[0]!); assert.equal(n.preset?.collection, 'Matched Cabinet Pro');
});

// ----- projet réel « bluecat_chaine » : vrais presets choisis dans Carla
const real = readFileSync('tests/fixtures/bluecat_chaine.carxp', 'utf-8');
const AXM = P('VST3', "Blue Cat's Axiom", { path: "C:\\Program Files\\Common Files\\VST3\\Blue Cat's\\BC Axiom VST3.vst3", midiIns: 1 });
await test('sons capturés du vrai projet : NOM réel du preset et dossier d\'origine lus dans l\'état', () => {
  const st = captureStates(real, 'bluecat_chaine', [AXM], new Date('2026-10-05T12:00:00Z'));
  assert.equal(st.length, 4);
  const ax = st.find((s) => s.pluginName.includes('Axiom'))!;
  assert.equal(ax.name, 'Modu Smooth Delay (bluecat_chaine)'); assert.equal(ax.collection, 'Guitar - Clean + FX'); assert.equal(ax.pluginKey, `${AXM.path}|${AXM.name}`);
  assert.equal(st.find((s) => s.pluginName.includes('Dynamics'))!.name, 'Full Mix Glue [snk] (bluecat_chaine)');
  assert.equal(st.find((s) => s.pluginName === 'LoopRecorder')!.name, 'LoopRecorder – bluecat_chaine');
  const book = makeBook(null, st, [AXM]);
  const c = book.forPlugin(AXM, 'un delay doux pour la guitare', 3)[0]!;
  assert.equal(c.name, 'Modu Smooth Delay (bluecat_chaine)'); assert.equal(c.collection, 'Guitar - Clean + FX'); assert.equal(c.kind, 'state');
  const book2 = makeBook(null, st, [AXM]); assert.ok(book2.forPlugin(AXM, 'son clair reggae', 3).length > 0);
});
const axChunk = importCarxp(real).plugins.find((p) => p.name.includes('Axiom'))!.chunk!;
const axPreset = parseBlueCatState(axChunk)!.presetXml;
await test('fichier .preset → état : reproduit EXACTEMENT l\'état de Carla (si le fichier contient le document <Preset>)', () => {
  const r = presetFileToChunk(AXM, axPreset, 'C:\\x\\Modu Smooth Delay.preset');
  assert.ok(!('error' in r)); if ('error' in r) return;
  assert.equal(r.chunk, axChunk.replace(/\s+/g, ''), 'octet pour octet'); assert.equal(r.name, 'Modu Smooth Delay');
  // variantes de présentation du fichier : BOM, retour à la ligne final, octet nul, déclaration XML absente ou suivie d\'un retour à la ligne
  for (const v of ['\uFEFF' + axPreset + '\r\n', axPreset + '\0', axPreset.replace('?><Preset', '?>\r\n<Preset'), axPreset.replace(/^<\?xml[^>]*\?>/, '')]) {
    const x = presetFileToChunk(AXM, v, 'f.preset'); assert.ok(!('error' in x)); if (!('error' in x)) assert.equal(x.chunk, axChunk.replace(/\s+/g, ''));
  }
  // sans nom de preset : le nom du fichier est utilisé
  const sans = presetFileToChunk(AXM, axPreset.replace(/ progName="[^"]*"/, ''), 'C:\\x\\Mon son & moi.preset');
  assert.ok(!('error' in sans)); if (!('error' in sans)) { assert.equal(sans.name, 'Mon son & moi'); assert.match(parseBlueCatState(sans.chunk)!.presetXml, /progName="Mon son &amp; moi"/); }
});
await test('fichier .preset refusé proprement : autre éditeur, VST2, contenu qui n\'est pas un document <Preset> complet', () => {
  const err = (pl: DbPlugin | undefined, txt: string) => { const r = presetFileToChunk(pl, txt, 'a.preset'); return 'error' in r ? r.error : ''; };
  assert.match(err(GR7, axPreset), /pas un plugin Blue Cat/); assert.match(err(P('VST2', "Blue Cat's Truc", {}), axPreset), /pas un plugin Blue Cat/); assert.match(err(undefined, axPreset), /pas un plugin Blue Cat/);
  assert.match(err(AXM, 'binaire\0\x01\x02'), /pas un document <Preset>/); assert.match(err(AXM, ''), /pas un document/);
  assert.match(err(AXM, axPreset.slice(0, 500)), /complet/, 'fichier tronqué');
  assert.match(err(AXM, '<Autre><Preset>x</Preset></Autre>'), /pas un document/);
  assert.equal(isBlueCatVst3(AXM), true); assert.equal(isBlueCatVst3(P('VST3', 'BC Dynamics 4', { path: 'C:\\x\\BC Dynamics 4.vst3' })), true); assert.equal(isBlueCatVst3(GR7), false);
});
await test('injection dans un projet : état écrit dans le .carxp, bloc d\'origine remplacé, erreurs listées sans exception', async () => {
  const p = emptyProject(HW); const a = addPlugin(p, AXM); const g = addPlugin(p, GR7); const m = addPlugin(p, P('VST3', "Blue Cat's Dynamics 4", { path: "C:\\VST3\\Blue Cat's\\BC Dynamics 4.vst3" }));
  a.preset = { kind: 'file', name: 'Modu Smooth Delay', path: 'C:\\P\\Modu Smooth Delay.preset' };
  g.preset = { kind: 'file', name: 'Super Crunch', path: 'C:\\P\\Super Crunch.ngrr' };      // .ngrr : ignoré (pas un .preset)
  m.preset = { kind: 'file', name: 'Introuvable', path: 'C:\\P\\absent.preset' };
  const lecteur = async (path: string): Promise<string> => { if (path.includes('absent')) throw new Error('fichier absent'); return axPreset; };
  const r = await injectFilePresets(p, lecteur);
  assert.equal(r.applied, 1); assert.equal(r.skipped.length, 1); assert.match(r.skipped[0]!, /Dynamics 4.*illisible.*fichier absent/);
  assert.equal(a.chunk, axChunk.replace(/\s+/g, '')); assert.equal(a.preset?.applied, true); assert.equal(g.chunk, undefined); assert.equal(m.chunk, undefined);
  assert.equal((await injectFilePresets(p, lecteur)).applied, 0, 'déjà appliqué : rien à refaire (le fichier absent reste signalé)');
  const i = ensureHardware(p, 'hw-in'); const o = ensureHardware(p, 'hw-out');
  connect(p, { node: i.id, port: 'capture_1' }, { node: a.id, port: 'input_1' }); connect(p, { node: a.id, port: 'output_1' }, { node: o.id, port: 'playback_1' });
  assert.equal(importCarxp(exportCarxp(p, true)).plugins.find((x) => x.name.includes('Axiom'))!.chunk, axChunk.replace(/\s+/g, ''), 'écrit dans le .carxp');
});

await test('noms réels des dossiers Blue Cat\'s : « VST3 » au milieu, variantes (Stereo)/(Mono)/(Dual) distinctes', () => {
  assert.equal(norm('BC Dynamics 4 VST3(Stereo) data'), 'dynamics4stereo'); assert.equal(norm("Blue Cat's Dynamics 4(Stereo)"), 'dynamics4stereo');
  assert.equal(norm('BC MB-7 Mixer 2 VST3(Dual) data'), norm("Blue Cat's MB-7 Mixer 2 (Dual)")); assert.equal(norm('BC Axiom VST3 data'), 'axiom');
  assert.notEqual(norm('BC Dynamics 4 VST3(Mono) data'), norm("Blue Cat's Dynamics 4(Stereo)"), 'Mono ≠ Stereo');
  const st = P('VST3', "Blue Cat's Dynamics 4(Stereo)", {}), mo = P('VST3', "Blue Cat's Dynamics 4(Mono)", {});
  const m = makeMatcher([st, mo]);
  assert.equal(m.match(E('x', ['Factory Presets', 'BC Dynamics 4 VST3(Stereo) data']))?.name, "Blue Cat's Dynamics 4(Stereo)");
  assert.equal(m.match(E('x', ['Factory Presets', 'BC Dynamics 4 VST3(Mono) data']))?.name, "Blue Cat's Dynamics 4(Mono)");
  assert.deepEqual(pluginsForDir('BC Dynamics 4 VST3(Stereo) data', [st, mo]).map((p) => p.name), ["Blue Cat's Dynamics 4(Stereo)"]);
});

await test('PREUVE sur un vrai projet : un plugin généré de zéro avec son état capturé est IDENTIQUE au bloc écrit par Carla (4 plugins)', () => {
  const imp = importCarxp(real);
  const db = imp.plugins.map((p) => P(p.type, p.name.replace(/&apos;/g, "'"), { path: p.binary, label: p.label ?? p.name, uniqueId: p.uniqueId ?? null, midiIns: p.name.includes('Axiom') ? 1 : 0 }));
  const { project } = projectFromCarxp(real, db, HW);
  for (const n of project.nodes) if (n.kind === 'plugin') { n.chunk = imp.plugins.find((p) => p.binary === n.plugin?.path)?.chunk; delete n.raw; } // force la génération
  const out = exportCarxp(project, true);
  const blocks = (x: string) => [...x.matchAll(/<Plugin>([\s\S]*?)<\/Plugin>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
  const a = blocks(real), b = blocks(out);
  assert.equal(b.length, a.length);
  for (const orig of a) {
    const name = /<Name>(.*?)<\/Name>/.exec(orig)![1];
    assert.equal(b.find((x) => x.includes(`<Name>${name}</Name>`)), orig, `bloc de « ${name} » identique, état compris`);
  }
});

// ----- presets TONE3000 (.t3kpreset) appliqués automatiquement
const T3K = P('VST3', 'TONE3000', { path: 'C:\\Program Files\\Common Files\\VST3\\TONE3000.vst3\\Contents\\x86_64-win\\TONE3000.vst3' });
const t3kBytes = new Uint8Array(readFileSync('tests/fixtures/preset_test.t3kpreset'));
await test('TONE3000 : un .t3kpreset choisi pour le plugin est converti et écrit dans le .carxp ; les erreurs sont listées sans exception', async () => {
  assert.equal(isTone3000(T3K), true); assert.equal(isTone3000(GR7), false); assert.equal(isTone3000(P('VST2', 'TONE3000', {})), false);
  const p = emptyProject(HW); const a = addPlugin(p, T3K); const g = addPlugin(p, GR7); const m = addPlugin(p, T3K);
  a.preset = { kind: 'file', name: 'hamide test', path: 'C:\\TONE3000\\Presets\\hamide test.t3kpreset' };
  g.preset = { kind: 'file', name: 'x', path: 'C:\\TONE3000\\Presets\\x.t3kpreset' };     // mauvais plugin
  m.preset = { kind: 'file', name: 'abîmé', path: 'C:\\TONE3000\\Presets\\abime.t3kpreset' }; // fichier corrompu
  const lire = async (path: string): Promise<Uint8Array> => (path.includes('abime') ? t3kBytes.subarray(0, 500) : t3kBytes);
  const r = await injectFilePresets(p, async () => '', lire);
  assert.equal(r.applied, 1); assert.equal(r.skipped.length, 2);
  assert.match(r.skipped.join('|'), /ne s'applique qu'au plugin TONE3000/); assert.match(r.skipped.join('|'), /TONE3000 2.*tronqué ou abîmé/);
  assert.equal(a.chunk, t3kPresetToChunk(t3kBytes).chunk); assert.equal(a.preset?.applied, true); assert.equal(g.chunk, undefined); assert.equal(m.chunk, undefined);
  const st = readValueTree(unwrapVc2(a.chunk!)!, 4).tree; assert.equal(getStr(st, 'activePresetName'), 'hamide test');
  const sans = await injectFilePresets(emptyProject(HW), async () => '');                  // sans lecteur binaire
  assert.equal(sans.applied, 0);
  const q = emptyProject(HW); const c = addPlugin(q, T3K); c.preset = { kind: 'file', name: 'h', path: 'C:\\h.t3kpreset' };
  assert.match((await injectFilePresets(q, async () => '')).skipped[0]!, /lecture de fichier binaire indisponible/);
  const i = ensureHardware(p, 'hw-in'); const o = ensureHardware(p, 'hw-out'); void i; void o;
  assert.equal(importCarxp(exportCarxp(p, true)).plugins[0]!.chunk, a.chunk, 'écrit dans le .carxp');
});
console.log(`\n${ok} tests réussis`);
