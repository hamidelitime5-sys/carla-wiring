// Test : npx tsx tests/chain.test.ts
import assert from 'node:assert/strict';
import { buildCatalog, chainToProject, generateChain, parseChain, selectForRequest, systemPrompt, userPrompt, type AskFn } from '../src/lib/chain';
import { addPlugin, autoLayout, connect, disconnect, emptyProject, ensureHardware, removeNode, uniqueName } from '../src/lib/editor';
import { exportCarxp, importCarxp, type DbPlugin, type HardwareProfile } from '../src/lib/carxp';
import { makeBook, type PresetIndex } from '../src/lib/presets';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };

const P = (type: string, name: string, over: Partial<DbPlugin>): DbPlugin => ({
  type, name, label: name, maker: 'Éditeur', path: `C:\\VST\\${name}.${type === 'VST3' ? 'vst3' : 'dll'}`, uniqueId: type === 'VST2' ? 1000 + name.length : null,
  category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over,
});
const DB: DbPlugin[] = [
  P('VST3', 'Guitar Rig 7', { midiIns: 1 }),               // p1 effet stéréo
  P('VST2', 'Compresseur 1176', {}),                        // p2
  P('VST3', 'Limiteur Live', {}),                           // p3
  P('VST2', 'Kontakt 7', { isSynth: true, audioIns: 0, audioOuts: 16, midiIns: 1 }), // p4 instrument multi-sorties
  P('VST3', 'Ampli Mono', { audioIns: 1, audioOuts: 1 }),   // p5
];
const HW: HardwareProfile = { name: 't', audioIn: ['capture_1', 'capture_2'], audioOut: ['playback_1', 'playback_2'], midiIn: ['Capture 1'] };
const cat = buildCatalog(DB);

const BON = JSON.stringify({
  name: 'Guitare lead live', summary: 'Ampli puis compresseur puis limiteur.', notes: ['Réglez le gain'], missing: [],
  nodes: [{ id: 'n1', plugin: 'p1', role: 'ampli' }, { id: 'n2', plugin: 'p2' }, { id: 'n3', plugin: 'p3' }],
  cables: [
    { from: 'in:capture_1', to: 'n1:input_1' }, { from: 'in:capture_1', to: 'n1:input_2' },
    { from: 'n1:output_1', to: 'n2:input_1' }, { from: 'n1:output_2', to: 'n2:input_2' },
    { from: 'n2:output_1', to: 'n3:input_1' }, { from: 'n2:output_2', to: 'n3:input_2' },
    { from: 'n3:output_1', to: 'out:playback_1' }, { from: 'n3:output_2', to: 'out:playback_2' },
  ],
});

await test('catalogue : identifiants courts, rôle instrument/effet, troncature signalée', () => {
  assert.equal(cat.byId.get('p4')?.name, 'Kontakt 7');
  assert.match(cat.text, /p4 \| Kontakt 7 \| VST2 \| Éditeur \| instrument \| in:0 out:16 midi:oui/);
  const big = buildCatalog(Array.from({ length: 700 }, (_, i) => P('VST3', 'X' + i, {})), 600);
  assert.equal(big.shown, 600); assert.equal(big.total, 700);
  assert.match(userPrompt('test', big, HW), /liste tronquée/);
  assert.match(systemPrompt(), /UNIQUEMENT les plugins du catalogue/);
});
await test('une bonne chaîne est acceptée, câblée, disposée en colonnes', () => {
  const r = chainToProject(parseChain(BON), cat, HW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.project.nodes.length, 5); // 3 plugins + in + out
  assert.equal(r.project.cables.length, 8);
  const xs = r.project.nodes.map((n) => n.x);
  assert.ok(new Set(xs).size >= 4, 'plusieurs colonnes');
  const x = exportCarxp(r.project, true);
  assert.equal(importCarxp(x).plugins.length, 3);
  assert.equal(importCarxp(x).connections.length, 8);
  assert.ok(importCarxp(x).connections.some(([s, t]) => s === 'Audio Input:capture_1' && t === 'Guitar Rig 7:input_1'));
});
await test('JSON entouré de texte et de balises ```json : accepté', () => {
  const c = parseChain('Voici ma proposition :\n```json\n' + BON + '\n```\nBon concert !');
  assert.equal(c.nodes.length, 3);
});
await test('plugin inventé / absent du catalogue : refusé avec un message précis', () => {
  const c = parseChain(JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p99' }], cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'out:playback_1' }] }));
  const r = chainToProject(c, cat, HW);
  assert.ok(r.errors.some((e) => /p99/.test(e) && /catalogue/.test(e)));
});
await test('port inexistant, mauvaise direction, audio vers MIDI, nœud inconnu : refusés', () => {
  const mk = (cables: Array<[string, string]>) => chainToProject(parseChain(JSON.stringify({
    nodes: [{ id: 'n1', plugin: 'p1' }, { id: 'k', plugin: 'p4' }],
    cables: [...cables, ['n1:output_1', 'out:playback_1']].map(([from, to]) => ({ from, to })),
  })), cat, HW).errors.join(' | ');
  assert.match(mk([['in:capture_1', 'n1:input_9']]), /pas une ENTRÉE/);
  assert.match(mk([['n1:input_1', 'n1:output_1']]), /pas une SORTIE/);
  assert.match(mk([['n1:output_1', 'k:events-in']]), /interdit.*audio vers midi/);
  assert.match(mk([['zz:output_1', 'n1:input_1']]), /n'existe pas/);
  assert.match(mk([['in:capture_1', 'n1:input_1'], ['n1:output_1', 'out:nimporte']]), /pas une ENTRÉE/);
  assert.match(mk([['mal ecrit', 'n1:input_1']]), /mal écrit/);
});
await test('rien n\'arrive à la sortie : refusé ; plugin inutile : avertissement', () => {
  const sans = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p1' }], cables: [{ from: 'in:capture_1', to: 'n1:input_1' }] })), cat, HW);
  assert.ok(sans.errors.some((e) => /sortie de la carte/.test(e)));
  const inutile = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p1' }, { id: 'n2', plugin: 'p2' }],
    cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'out:playback_1' }, { from: 'in:capture_2', to: 'n2:input_1' }] })), cat, HW);
  assert.deepEqual(inutile.errors, []);
  assert.ok(inutile.warnings.some((w) => /n'arrive pas jusqu'à la sortie/.test(w)));
});
await test('le même plugin utilisé deux fois reçoit deux noms Carla distincts', () => {
  const r = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p2' }, { id: 'n2', plugin: 'p2' }],
    cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'n2:input_1' }, { from: 'n2:output_1', to: 'out:playback_1' }] })), cat, HW);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.project.nodes.filter((n) => n.kind === 'plugin').map((n) => n.name), ['Compresseur 1176', 'Compresseur 1176 2']);
});
await test('instrument multi-sorties : MIDI relié, 16 sorties disponibles ; instrument sans MIDI : avertissement', () => {
  const ok2 = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'k', plugin: 'p4' }],
    cables: [{ from: 'midi:Capture 1', to: 'k:events-in' }, { from: 'k:output_1', to: 'out:playback_1' }, { from: 'k:output_2', to: 'out:playback_2' }] })), cat, HW);
  assert.deepEqual(ok2.errors, []);
  assert.deepEqual(ok2.warnings.filter((w) => /MIDI/.test(w)), []);
  const sansMidi = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'k', plugin: 'p4' }], cables: [{ from: 'k:output_1', to: 'out:playback_1' }] })), cat, HW);
  assert.ok(sansMidi.warnings.some((w) => /ne reçoit pas de MIDI/.test(w)));
});

await test('boucle IA : 1er essai en JSON cassé, 2e avec un plugin inventé, 3e correct → les fautes sont renvoyées à l\'IA', async () => {
  const reponses = ['désolé, voici du texte', JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p77' }], cables: [] }), BON];
  const recu: string[][] = [];
  const ask: AskFn = async (_s, msgs) => { recu.push(msgs.map((m) => m.content)); return reponses[recu.length - 1] ?? ''; };
  const logs: string[] = [];
  const o = await generateChain(ask, 'guitare lead live', DB, HW, (l) => logs.push(l));
  assert.equal(o.ok, true); assert.equal(o.attempts, 3);
  assert.match(recu[1]?.[2] ?? '', /JSON illisible|aucun objet JSON/);
  assert.match(recu[2]?.[4] ?? '', /p77/);
  assert.ok(logs.some((l) => /Essai 3.*valide/.test(l)));
});
await test('boucle IA : 3 échecs → échec honnête ; demande vide ou base vide → refus sans appeler l\'IA', async () => {
  let appels = 0;
  const ask: AskFn = async () => { appels++; return '{"nodes":[],"cables":[]}'; };
  const o = await generateChain(ask, 'x', DB, HW, () => undefined);
  assert.equal(o.ok, false); assert.equal(appels, 3); assert.match(o.error ?? '', /3 essais/);
  appels = 0;
  assert.equal((await generateChain(ask, '  ', DB, HW, () => undefined)).ok, false);
  assert.match((await generateChain(ask, 'x', [], HW, () => undefined)).error ?? '', /base de plugins est vide/);
  assert.match((await generateChain(ask, 'x', DB, { ...HW, audioOut: [] }, () => undefined)).error ?? '', /sortie de votre carte/);
  assert.equal(appels, 0);
});
await test('une erreur de l\'IA (quota, clé) remonte telle quelle', async () => {
  const ask: AskFn = async () => { throw new Error('Quota ou limite de requêtes dépassé (429)'); };
  await assert.rejects(() => generateChain(ask, 'x', DB, HW, () => undefined), /Quota/);
});

// ----- éditeur
await test('éditeur : ajout, noms uniques, connexion dans les deux sens, refus des câbles invalides', () => {
  const p = emptyProject(HW);
  const a = addPlugin(p, DB[0]!); const b = addPlugin(p, DB[0]!); const k = addPlugin(p, DB[3]!);
  assert.deepEqual([a.name, b.name], ['Guitar Rig 7', 'Guitar Rig 7 2']);
  assert.equal(uniqueName(p, 'Guitar Rig 7'), 'Guitar Rig 7 3');
  const inn = ensureHardware(p, 'hw-in'); const out = ensureHardware(p, 'hw-out'); const midi = ensureHardware(p, 'midi-in');
  assert.equal(ensureHardware(p, 'hw-in'), inn, 'un seul nœud matériel de chaque sorte');
  assert.equal(connect(p, { node: inn.id, port: 'capture_1' }, { node: a.id, port: 'input_1' }), null);
  assert.equal(connect(p, { node: b.id, port: 'input_1' }, { node: a.id, port: 'output_1' }), null, 'entrée cliquée en premier');
  assert.match(connect(p, { node: inn.id, port: 'capture_1' }, { node: a.id, port: 'input_1' }) ?? '', /existe déjà/);
  assert.match(connect(p, { node: a.id, port: 'output_1' }, { node: k.id, port: 'events-in' }) ?? '', /refusé/);
  assert.match(connect(p, { node: a.id, port: 'output_1' }, { node: b.id, port: 'output_1' }) ?? '', /Deux sorties/);
  assert.match(connect(p, { node: a.id, port: 'input_1' }, { node: b.id, port: 'input_1' }) ?? '', /Deux entrées/);
  assert.match(connect(p, { node: a.id, port: 'output_1' }, { node: a.id, port: 'input_1' }) ?? '', /lui-même/);
  assert.equal(connect(p, { node: midi.id, port: 'Capture 1' }, { node: k.id, port: 'events-in' }), null);
  assert.equal(connect(p, { node: k.id, port: 'output_1' }, { node: out.id, port: 'playback_1' }), null);
  assert.equal(p.cables.length, 4);
  disconnect(p, 0); assert.equal(p.cables.length, 3);
  removeNode(p, k.id);
  assert.equal(p.cables.length, 1, 'les câbles du nœud supprimé disparaissent');
  autoLayout(p);
  assert.ok(p.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

await test('catalogue trop gros : on garde les plugins pertinents pour la demande, ceux déjà utilisés, dans l\'ordre d\'origine', () => {
  const gros = Array.from({ length: 700 }, (_, i) => P('VST3', 'Synthé inutile ' + i, {}));
  gros[650] = P('VST3', 'Compresseur Opto', {}); gros[651] = P('VST3', 'Limiteur Brickwall', {});
  gros[652] = P('VST3', 'Ampli Guitar Rig', { midiIns: 1 }); gros[653] = P('VST2', 'Reverb Plate', {});
  const sel = selectForRequest(gros, 'guitare lead avec compresseur, limiteur et reverb', 60);
  assert.equal(sel.length, 60);
  const noms = sel.map((p) => p.name);
  for (const n of ['Compresseur Opto', 'Limiteur Brickwall', 'Ampli Guitar Rig', 'Reverb Plate']) assert.ok(noms.includes(n), n);
  const idx = sel.map((p) => gros.indexOf(p)); assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.ok(selectForRequest(gros, 'x', 60, [gros[10]!]).includes(gros[10]!), 'un plugin déjà utilisé est toujours conservé');
  assert.equal(selectForRequest(DB, 'x', 600), DB, 'inchangé quand la base tient');
});
await test('generateChain avec un petit catalogue (modèle local) : réduction signalée, plugins utiles envoyés', async () => {
  const gros = Array.from({ length: 300 }, (_, i) => P('VST3', 'Machin ' + i, {}));
  gros[290] = P('VST3', 'Compresseur Opto', {});
  let prompt = ''; const logs: string[] = [];
  await generateChain(async (_s, m) => { prompt = m[0]?.content ?? ''; return '{"nodes":[],"cables":[]}'; }, 'guitare avec compresseur', gros, HW, (l) => logs.push(l), undefined, { maxCatalog: 80 });
  assert.match(prompt, /Compresseur Opto/);
  assert.ok((prompt.match(/^p\d+ \|/gm) ?? []).length <= 80);
  assert.ok(logs.some((l) => /Catalogue réduit : 80 plugins sur 300/.test(l)), logs.join(' / '));
  assert.ok(logs.some((l) => /réponse reçue en \d+ s/.test(l)), 'durée de la réponse journalisée');
});

// ----- presets proposés par l'IA
const PE = (name: string, hint: string) => ({ path: `C:\\P\\${hint}\\${name}.fxp`, name, ext: 'fxp', kind: 'fxp', vstId: null, classId: null, hints: ['Presets', hint], size: 1 });
const pIndex: PresetIndex = { version: 1, scannedAt: '', roots: [], extensions: ['fxp'], truncated: false, entries: [PE('Lead saturé chaud', 'Guitar Rig 7'), PE('Clean jazz', 'Guitar Rig 7'), PE('Opto doux', 'Compresseur 1176')] };
const book = makeBook(pIndex, [{ id: 'st-1', name: 'Limiteur – concert', pluginKey: `${DB[2]!.path}|${DB[2]!.name}`, pluginName: 'Limiteur Live', chunk: 'Q0hVTks=', source: 'concert', createdAt: '' }], DB);
const idPlugin = (n: string) => [...buildCatalog(DB).byId].find(([, p]) => p.name === n)![0];
const avecPresets = (extra: Record<string, unknown>) => JSON.stringify({ name: 'g', nodes: [{ id: 'n1', plugin: 'p1', ...extra }, { id: 'n2', plugin: 'p2' }, { id: 'n3', plugin: 'p3', ...(extra.state ? { preset: 's4' } : {}) }],
  cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'n2:input_1' }, { from: 'n2:output_1', to: 'n3:input_1' }, { from: 'n3:output_1', to: 'out:playback_1' }] });

await test('presets : la liste envoyée à l\'IA est classée selon la demande, avec les sons capturés signalés', async () => {
  let prompt = '';
  await generateChain(async (_s, m) => { prompt = m[0]?.content ?? ''; return '{"nodes":[],"cables":[]}'; }, 'guitare avec un son lead saturé', DB, HW, () => undefined, undefined, { presets: book });
  assert.match(prompt, /PRESETS DISPONIBLES/);
  assert.match(prompt, /p1 \(Guitar Rig 7\) : s1 « Lead saturé chaud » ; s2 « Clean jazz »/, prompt.split('PRESETS')[1]);
  assert.match(prompt, /« Limiteur – concert » \[son capturé\]/);
  assert.match(systemPrompt(), /N'invente JAMAIS de preset/);
  let sans = ''; await generateChain(async (_s, m) => { sans = m[0]?.content ?? ''; return '{"nodes":[],"cables":[]}'; }, 'x', DB, HW, () => undefined);
  assert.doesNotMatch(sans, /PRESETS DISPONIBLES/, 'rien si aucun preset');
});
await test('presets : un preset valide est attaché au plugin ; un « son capturé » injecte son état', async () => {
  const ids = (p: string) => idPlugin(p);
  assert.equal(ids('Guitar Rig 7'), 'p1');
  const o = await generateChain(async () => avecPresets({ preset: 's1', state: true }), 'guitare lead', DB, HW, () => undefined, undefined, { presets: book });
  assert.equal(o.ok, true, o.error);
  const n1 = o.result!.project.nodes.find((n) => n.name === 'Guitar Rig 7')!; const n3 = o.result!.project.nodes.find((n) => n.name === 'Limiteur Live')!;
  assert.deepEqual([n1.preset?.kind, n1.preset?.name], ['file', 'Lead saturé chaud']);
  assert.equal(n1.chunk, undefined, 'un fichier n\'est pas injecté');
  assert.deepEqual([n3.preset?.kind, n3.chunk], ['state', 'Q0hVTks=']);
  assert.equal(importCarxp(exportCarxp(o.result!.project, true)).plugins.find((p) => p.name === 'Limiteur Live')!.chunk, 'Q0hVTks=', 'écrit dans le .carxp');
});
await test('presets : identifiant inventé ou preset d\'un AUTRE plugin refusés, puis corrigés', async () => {
  const reps = [avecPresets({ preset: 's99' }), avecPresets({ preset: 's3' }), avecPresets({ preset: 's2' })]; // s3 = preset du compresseur
  const vus: string[] = [];
  const o = await generateChain(async (_s, m) => { vus.push(m[m.length - 1]!.content); return reps.shift()!; }, 'guitare', DB, HW, () => undefined, undefined, { presets: book });
  assert.equal(o.ok, true); assert.equal(o.attempts, 3);
  assert.match(vus[1]!, /s99.*n'existe pas/); assert.match(vus[2]!, /appartient au plugin p2, pas à p1/);
});
await test('modifier une chaîne : un son capturé choisi remplace l\'état hérité, un fichier garde les réglages d\'origine', async () => {
  const { projectFromCarxp } = await import('../src/lib/importer');
  const xml = (await import('node:fs')).readFileSync('tests/fixtures/bluecat_basse.carxp', 'utf-8');
  const prev = projectFromCarxp(xml, [], HW).project;
  const next = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p1' }], cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'out:playback_1' }] })), buildCatalog(DB), HW).project;
  const n = next.nodes.find((x) => x.kind === 'plugin')!; n.plugin = { ...prev.nodes[0]!.plugin! }; n.name = 'x';
  const { inheritFrom } = await import('../src/lib/chain');
  n.preset = { kind: 'state', name: 'S' }; n.chunk = 'NOUVEAU';
  inheritFrom(next, prev); assert.equal(n.chunk, 'NOUVEAU'); assert.equal(n.raw, undefined);
  const n2 = chainToProject(parseChain(JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p1' }], cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'out:playback_1' }] })), buildCatalog(DB), HW).project;
  const m = n2.nodes.find((x) => x.kind === 'plugin')!; m.plugin = { ...prev.nodes[0]!.plugin! }; m.preset = { kind: 'file', name: 'F', path: 'x.fxp' };
  inheritFrom(n2, prev); assert.ok(m.raw, 'réglages d\'origine conservés'); assert.equal(m.preset.name, 'F');
});

await test('presets : la famille (composant) est indiquée à l\'IA entre crochets', async () => {
  const e = (name: string, ...hints: string[]) => ({ path: `C:\\x\\${name}.ngrr`, name, ext: 'ngrr', kind: 'other', vstId: null, classId: null, hints: [...hints, 'Guitar Rig 7'], size: 1 });
  const b = makeBook({ version: 1, scannedAt: '', roots: [], extensions: ['ngrr'], truncated: false, entries: [e('Spring Hall', 'Presets', 'Reflektor'), e('Super Crunch', 'Rack Presets'), e('Nu', 'Presets')] }, [], DB);
  let prompt = ''; await generateChain(async (_s, m) => { prompt = m[0]?.content ?? ''; return '{"nodes":[],"cables":[]}'; }, 'guitare', DB, HW, () => undefined, undefined, { presets: b });
  assert.match(prompt, /« Spring Hall » \[Reflektor\]/); assert.match(prompt, /« Super Crunch » \[Rack Presets\]/); assert.match(prompt, /« Nu »(?! \[)/, 'pas de crochets sans famille');
});
console.log(`\n${ok} tests réussis`);
