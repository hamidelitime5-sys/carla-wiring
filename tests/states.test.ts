// Test : npx tsx tests/states.test.ts : décompresseur + noms de presets lus dans l'état (BIAS FX 2, MeldaProduction, ReValver).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { exportCarxp, importCarxp, type DbPlugin } from '../src/lib/carxp';
import { addPlugin, emptyProject } from '../src/lib/editor';
import { projectFromCarxp } from '../src/lib/importer';
import { inflate, zlibInflate } from '../src/lib/inflate';
import { applyPreset, captureReport, captureStates, makeBook } from '../src/lib/presets';
import { checkVc2State } from '../src/lib/vst3state';
import { describeState } from '../src/lib/statenames';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const xml = readFileSync('tests/fixtures/trois_plugins.carxp', 'utf-8');
const imp = importCarxp(xml);
const by = (frag: string) => imp.plugins.find((p) => p.name.includes(frag))!;

// ----- décompresseur
let seed = 12345;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
const randomBytes = (n: number) => Uint8Array.from({ length: n }, () => rnd() & 255);
const text = (n: number) => Uint8Array.from(Buffer.from(Array.from({ length: n }, (_, i) => `mot${i % 37} clé=${(i * 7) % 101};`).join('').slice(0, n)));
await test('inflate : identique à zlib de Node (tailles, niveaux 0 à 9, aléatoire, texte, vide)', () => {
  const samples: Array<[string, Uint8Array]> = [['vide', new Uint8Array(0)], ['1 octet', new Uint8Array([42])], ['aléatoire 5 Ko', randomBytes(5000)], ['aléatoire 300 Ko', randomBytes(300_000)],
    ['texte 200 Ko', text(200_000)], ['zéros 1 Mo', new Uint8Array(1_000_000)], ['mixte', Uint8Array.from([...text(30_000), ...randomBytes(30_000), ...text(30_000)])]];
  for (const [nom, data] of samples) for (const level of [0, 1, 6, 9]) {
    assert.ok(eq(zlibInflate(deflateSync(data, { level })), data), `${nom} niveau ${level} (zlib)`);
    assert.ok(eq(inflate(deflateRawSync(data, { level })), data), `${nom} niveau ${level} (brut)`);
  }
});
await test('inflate : octets en trop après le flux ignorés (cas de Melda : 262144 octets pour un flux plus court) ; erreurs propres', () => {
  const d = text(10_000); const z = deflateSync(d);
  const padded = new Uint8Array(z.length + 5000); padded.set(z);
  assert.ok(eq(zlibInflate(padded), d), 'remplissage de zéros à la fin');
  assert.throws(() => zlibInflate(z.subarray(0, z.length - 20)), /tronqu/);
  assert.throws(() => zlibInflate(new Uint8Array([0x00, 0x01, 2, 3])), /zlib invalide/);
  assert.throws(() => inflate(new Uint8Array([0xff, 0xff, 0xff])), /invalide|tronqu/);
  assert.throws(() => zlibInflate(new Uint8Array(0)), /zlib invalide/);
});

// ----- noms lus dans l'état, sur le vrai projet
await test('projet réel : nom du preset lu pour BIAS FX 2 et Melda ; ReValver (binaire opaque) honnêtement inconnu', () => {
  assert.deepEqual(describeState(by('BIAS FX 2').chunk), { family: 'bias', name: 'American Dream' });
  assert.deepEqual(describeState(by('MCabinetMB').chunk), { family: 'melda', name: 'Timely fork', collection: 'Medium' });
  assert.deepEqual(describeState(by('ReValver').chunk), { family: 'unknown' });
  assert.deepEqual(describeState('AAAA'), { family: 'unknown' }); assert.deepEqual(describeState(''), { family: 'unknown' });
  const bc = describeState(importCarxp(readFileSync('tests/fixtures/bluecat_chaine.carxp', 'utf-8')).plugins.find((p) => p.name.includes('Axiom'))!.chunk);
  assert.deepEqual(bc, { family: 'bluecat', name: 'Modu Smooth Delay', collection: 'Guitar - Clean + FX' });
});
await test('le programme actif noté par Carla (Melda) est lu à l\'import', () => {
  assert.equal(by('MCabinetMB').programIndex, 1); assert.equal(by('MCabinetMB').programName, '0');
  assert.equal(by('BIAS FX 2').programIndex, undefined);
});

// ----- preuve : blocs régénérés identiques à ceux de Carla
const HW = { name: 'c', audioIn: ['capture_1', 'capture_2'], audioOut: ['playback_1', 'playback_2'], midiIn: ['Capture 1'] };
const dbOf = (): DbPlugin[] => imp.plugins.map((p) => ({ type: p.type, name: p.name, label: p.label || p.name, maker: '', path: p.binary, uniqueId: p.uniqueId, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0 }));
const blocks = (x: string) => [...x.matchAll(/<Plugin>([\s\S]*?)<\/Plugin>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
await test('PREUVE : BIAS FX 2, MeldaProduction et ReValver régénérés de zéro avec leur état = blocs de Carla, octet pour octet', () => {
  const { project } = projectFromCarxp(xml, dbOf(), HW);
  for (const n of project.nodes) if (n.kind === 'plugin') delete n.raw; // force la génération complète
  const a = blocks(xml), b = blocks(exportCarxp(project, true));
  assert.equal(b.length, 3);
  for (const orig of a) { const name = /<Name>(.*?)<\/Name>/.exec(orig)![1]; assert.equal(b.find((x) => x.includes(`<Name>${name}</Name>`)), orig, `« ${name} »`); }
});
await test('sons capturés : noms réels, famille, programme ; appliqués à de NOUVEAUX plugins ils redonnent exactement les blocs de Carla', () => {
  const db = dbOf();
  const st = captureStates(xml, 'trois_plugins', db, new Date('2026-10-05T12:00:00Z'));
  assert.deepEqual(st.map((s) => s.name), ['American Dream (trois_plugins)', 'Timely fork (trois_plugins)', 'ReValver – trois_plugins']);
  assert.equal(st[1]!.collection, 'Medium'); assert.deepEqual(st[1]!.program, { index: 1, name: '0' }); assert.equal(st[0]!.program, undefined);
  const book = makeBook(null, st, db);
  const p = emptyProject(HW);
  const nodes = db.map((d) => addPlugin(p, d));
  nodes.forEach((n, i) => { const c = book.forPlugin(db[i]!, '', 3)[0]!; applyPreset(n, c); });
  const out = exportCarxp({ ...p, cables: [] }, true);
  const a = blocks(xml), b = blocks(out);
  for (const orig of a) { const name = /<Name>(.*?)<\/Name>/.exec(orig)![1]; assert.equal(b.find((x) => x.includes(`<Name>${name}</Name>`)), orig, `« ${name} » recréé de zéro`); }
  // un son sans programme efface celui d'un état précédent
  applyPreset(nodes[1]!, { kind: 'state', name: 'x', chunk: 'QUJD' }); assert.equal(nodes[1]!.program, undefined);
});

// ----- TONE3000 (plugin NAM/IR officiel) : métadonnées des captures du catalogue lues dans l'état
const t3k = readFileSync('tests/fixtures/tone3000.carxp', 'utf-8');
const t3kImp = importCarxp(t3k);
await test('TONE3000 : titres, appareils et tags des 3 blocs de la chaîne lus dans l\'état (amp Marshall, Neve 1073, IR de catacombes)', () => {
  const info = describeState(t3kImp.plugins[0]!.chunk);
  assert.equal(info.family, 'tone3000');
  assert.match(info.name!, /^Marshall Bluesbreaker \+ Neve 1073LB \+ The Green-Wood Cemetery Catacombs$/);
  assert.equal(info.collection, 'amp-cab + outboard + space');
  for (const k of ['clapton', 'blues', 'neve']) assert.ok(info.keywords!.includes(k), `mot-clé « ${k} »`);
  assert.equal(t3kImp.plugins[0]!.programName, 'Ampeg Bass Drive', 'programme noté par Carla (l\'état, appliqué ensuite, l\'emporte)');
});
await test('TONE3000 : bloc régénéré de zéro avec l\'état = bloc de Carla ; une demande « à la Clapton » le place devant un son sans rapport', () => {
  const d = t3kImp.plugins[0]!;
  const db: DbPlugin[] = [{ type: d.type, name: d.name, label: d.label || d.name, maker: '', path: d.binary, uniqueId: null, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0 }];
  const p = emptyProject(HW); const n = addPlugin(p, db[0]!);
  const st = captureStates(t3k, 'tone3000', db, new Date('2026-10-05T12:00:00Z'))[0]!;
  assert.equal(st.collection, 'amp-cab + outboard + space'); assert.ok(st.keywords!.length > 5);
  applyPreset(n, { kind: 'state', name: st.name, stateId: st.id, chunk: st.chunk, program: st.program });
  const a = blocks(t3k), b = blocks(exportCarxp({ ...p, cables: [] }, true));
  assert.equal(b[0], a[0], 'identique, octet pour octet');
  const autre = { ...st, id: 'st-autre', name: 'Un son sans rapport (autre)', keywords: ['metal'], collection: undefined };
  const book = makeBook(null, [autre, st], db);
  assert.equal(book.forPlugin(db[0]!, 'un solo blues à la clapton', 2)[0]!.stateId, st.id);
  assert.equal(book.forPlugin(db[0]!, 'du metal', 2)[0]!.stateId, 'st-autre');
});

// ----- intégrité des états : les vrais fichiers de Carla passent, les états tronqués par l'IA sont refusés
const fx = (f: string) => importCarxp(readFileSync(`tests/fixtures/${f}`, 'utf-8'));
await test('INTÉGRITÉ : tous les états enregistrés par Carla (Blue Cat\'s, Melda, BIAS FX 2, ReValver, TONE3000, VST2) sont reconnus complets', () => {
  let n = 0;
  for (const f of ['bluecat_chaine.carxp', 'bluecat_basse.carxp', 'trois_plugins.carxp', 'tone3000.carxp', 'revalver5.carxp', 'benson_jazz_gig.carxp']) {
    for (const p of fx(f).plugins) { const c = checkVc2State(p.chunk); assert.deepEqual(c, { ok: true }, `${f} / ${p.name} : ${c.problem}`); n++; }
  }
  assert.ok(n >= 12, `${n} états vérifiés`);
});
await test('INTÉGRITÉ : les états BIAS FX 2 coupés par l\'IA de Google (1,3 Ko et 2,9 Ko au lieu de 463 Ko) sont refusés avec la raison', () => {
  const a = fx('google_biasfx_tronque.carxp').plugins.find((p) => p.name === 'BIAS FX 2')!;
  const b = fx('google_clairreggae_tronque.carxp').plugins[0]!;
  assert.match(checkVc2State(a.chunk).problem!, /état tronqué : 463118 octets annoncés, 1301 présents/);
  assert.match(checkVc2State(b.chunk).problem!, /base64 incomplet/);
  assert.equal(checkVc2State('').ok, true, 'pas d\'état : rien à vérifier');
  assert.equal(checkVc2State('%%%').ok, false);
  // un seul octet altéré dans la longueur annoncée, ou des données raccourcies d'un caractère
  const real = by('BIAS FX 2').chunk.replace(/\s+/g, ''); const raw = Buffer.from(real, 'base64');
  const mut = Buffer.from(raw); mut.writeUInt32LE(raw.readUInt32LE(4) + 1, 4);
  assert.match(checkVc2State(mut.toString('base64')).problem!, /tronqué/);
  const cut = Buffer.concat([raw.subarray(0, raw.length - 1 - 600), Buffer.from('</IComponent></VST3PluginState>\0')]);
  cut.writeUInt32LE(cut.length - 9, 4);
  assert.match(checkVc2State(cut.toString('base64')).problem!, /données incomplètes|illisible/);
});
await test('capture et ouverture : un état abîmé n\'est JAMAIS capturé, et l\'ouverture du projet prévient', () => {
  const xmlA = readFileSync('tests/fixtures/google_biasfx_tronque.carxp', 'utf-8');
  const rep = captureReport(xmlA, 'google', []);
  assert.equal(rep.states.length, 0); assert.equal(rep.rejected.length, 1); assert.match(rep.rejected[0]!.problem, /tronqué/);
  const mix = captureReport(readFileSync('tests/fixtures/trois_plugins.carxp', 'utf-8'), 'ok', dbOf());
  assert.equal(mix.states.length, 3); assert.equal(mix.rejected.length, 0);
  const { warnings } = projectFromCarxp(xmlA, [], HW);
  assert.ok(warnings.some((w) => /L'état enregistré de « BIAS FX 2 » est abîmé \(état tronqué/.test(w) && /réglages d'usine/.test(w)), warnings.join(' | '));
  assert.ok(!projectFromCarxp(readFileSync('tests/fixtures/benson_jazz_gig.carxp', 'utf-8'), [], HW).warnings.some((w) => /abîmé/.test(w)), 'un bon projet ne déclenche rien');
});
console.log(`\n${ok} tests réussis`);
