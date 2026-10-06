// Test : npx tsx tests/recipes.test.ts : rôles des plugins, fusion de la base, constructeur de recettes sans IA.
import assert from 'node:assert/strict';
import { validateProject, type DbPlugin, type HardwareProfile } from '../src/lib/carxp';
import { mergePlugins } from '../src/lib/pluginsdb';
import { makeBook, type PresetIndex, type StatePreset } from '../src/lib/presets';
import { buildFromRecipe, defaultGuitarInput, RECIPES, suggestRecipe } from '../src/lib/recipes';
import { guessRoles, roleCounts, rolesOf, type Role } from '../src/lib/roles';

let ok = 0;
const test = async (nom: string, f: () => void | Promise<void>) => { await f(); ok++; console.log('  OK  ' + nom); };
const P = (name: string, over: Partial<DbPlugin> = {}): DbPlugin => ({ type: 'VST3', name, label: name, maker: '', path: `C:\\VST3\\${name}.vst3`, uniqueId: null, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over });
const HW: HardwareProfile = { name: 'c', audioIn: ['Left', 'Right'], audioOut: ['Left', 'Right'], midiIn: [] };
const byRole = (names: string[]): string => names.join(' → ');

await test('fusion de la base : un scan AJOUTE et met à jour, il n\'efface plus ce qui existait', () => {
  const a = [P('A'), P('B')]; const r = mergePlugins(a, [P('B', { audioOuts: 1 }), P('C')]);
  assert.deepEqual(r.merged.map((p) => p.name).sort(), ['A', 'B', 'C']); assert.equal(r.added, 1); assert.equal(r.updated, 1);
  assert.equal(r.merged.find((p) => p.name === 'B')!.audioOuts, 1, 'données du dernier scan');
  assert.equal(mergePlugins([], []).merged.length, 0);
});
await test('rôles : vos plugins réels reconnus d\'après leur nom (Blue Cat\'s, Melda, BIAS, ReValver, TONE3000, Guitar Rig…)', () => {
  const r = (n: string, o: Partial<DbPlugin> = {}) => guessRoles(P(n, o)).join(',');
  assert.equal(r("Blue Cat's Axiom"), 'multi'); assert.equal(r('BIAS FX 2'), 'multi'); assert.equal(r('ReValver'), 'multi'); assert.equal(r('TONE3000'), 'multi'); assert.equal(r('Guitar Rig 7'), 'multi');
  assert.equal(r("Blue Cat's Dynamics 4(Stereo)"), 'comp'); assert.equal(r("Blue Cat's Liny EQ 5(Stereo)"), 'eq'); assert.equal(r("Blue Cat's Protector"), 'limiter');
  assert.equal(r("Blue Cat's MB-7 Mixer 2 (Dual)"), 'tool'); assert.equal(r('LoopRecorder'), 'tool'); assert.equal(r('TriplePlay'), 'tool');
  assert.equal(r('MCabinetMB'), 'cab'); assert.equal(r('MCompressor'), 'comp'); assert.equal(r('MEqualizer'), 'eq'); assert.equal(r('MReverb'), 'reverb'); assert.equal(r('MDelay'), 'delay');
  assert.equal(r('MChorus'), 'mod'); assert.equal(r('MFlanger'), 'mod'); assert.equal(r('Roland JC-120 Jazz Chorus'), 'amp', 'un Jazz Chorus est un ampli, pas une modulation');
  assert.equal(r('Fender Twin Reverb 65'), 'amp'); assert.equal(r('Morley Wah'), 'wah'); assert.equal(r('Octavia Fuzz'), 'drive'); assert.equal(r('Kontakt 7', { isSynth: true }), 'synth');
  assert.equal(r('Truc Inconnu'), '', 'inconnu : aucun rôle inventé');
  assert.equal(rolesOf(P('Truc Inconnu'), { 'C:\\VST3\\Truc Inconnu.vst3|Truc Inconnu': 'reverb' }).join(), 'reverb', 'correction manuelle');
  const c = roleCounts([P('MReverb'), P('MCompressor'), P('Truc')]); assert.equal(c.reverb, 1); assert.equal(c.comp, 1); assert.equal(c.none, 1);
});

const FULL = [P('MCompressor'), P('Opto Comp'), P('Fender Twin Reverb 65'), P('Roland JC-120 Jazz Chorus'), P('Marshall JTM45'), P('MEqualizer'), P('MReverb'), P('Spring Reverb'), P('MDelay'),
  P('MChorus'), P('Morley Wah'), P('Octavia Fuzz'), P('MCabinetMB'), P('LoopRecorder'), P('Kontakt 7', { isSynth: true, audioIns: 0, audioOuts: 16 })];

await test('recette Jazz (Benson) avec une base complète : comp → ampli Twin → égaliseur → ressort, câblé de la carte son à la carte son', () => {
  const r = buildFromRecipe(RECIPES.find((x) => x.id === 'jazz-benson')!, FULL, HW);
  assert.equal(r.ok, true); assert.deepEqual(r.missing, []);
  assert.equal(byRole(r.steps.filter((s) => s.plugin).map((s) => s.plugin!.name)), 'Opto Comp → Fender Twin Reverb 65 → MEqualizer → Spring Reverb');
  const p = r.project; assert.equal(p.nodes.length, 6);
  assert.deepEqual(validateProject(p, { requirePluginFiles: false }).filter((x) => x.level === 'error'), []);
  const gi = p.nodes.find((n) => n.kind === 'hw-in')!;
  assert.deepEqual(p.cables.filter((c) => c.fromNode === gi.id).map((c) => c.fromPort), ['Right', 'Right'], 'la guitare (entrée « Right ») alimente les DEUX entrées du premier plugin');
  const go = p.nodes.find((n) => n.kind === 'hw-out')!; assert.deepEqual(p.cables.filter((c) => c.toNode === go.id).map((c) => c.toPort).sort(), ['Left', 'Right']);
  assert.equal(r.notes.length, 2);
});
await test('chaque recette se construit et reste VALIDE avec la base complète ; instantané même avec 3000 plugins', () => {
  for (const rc of RECIPES) {
    const r = buildFromRecipe(rc, FULL, HW);
    assert.equal(r.ok, true, rc.id); assert.deepEqual(validateProject(r.project, { requirePluginFiles: false }).filter((x) => x.level === 'error'), [], rc.id);
  }
  const big = Array.from({ length: 3000 }, (_, i) => P(`Plugin ${i}`)).concat(FULL); const t0 = Date.now();
  buildFromRecipe(RECIPES[0]!, big, HW); assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
});
await test('préférences : « Jazz Chorus » pour le reggae, « Marshall » pour Clapton, « wah » pour Marvin', () => {
  const pick = (id: string, role: Role) => buildFromRecipe(RECIPES.find((x) => x.id === id)!, FULL, HW).steps.find((s) => s.role === role)?.plugin?.name;
  assert.equal(pick('reggae', 'amp'), 'Roland JC-120 Jazz Chorus'); assert.equal(pick('clapton', 'amp'), 'Marshall JTM45'); assert.equal(pick('reggae-marvin-rythmique', 'wah'), 'Morley Wah');
  assert.equal(pick('police-summers', 'mod'), 'MChorus'); assert.equal(pick('clapton', 'cab'), 'MCabinetMB');
});
await test('base pauvre (seulement des plugins tout-en-un) : le tout-en-un tient lieu d\'ampli, baffle et boost sont « déjà inclus », rien n\'est inventé', () => {
  const poor = [P('Guitar Rig 7'), P('TONE3000'), P("Blue Cat's Axiom"), P('MReverb')];
  const r = buildFromRecipe(RECIPES.find((x) => x.id === 'clapton')!, poor, HW);
  assert.equal(r.ok, true); assert.equal(r.steps.find((s) => s.role === 'amp')!.note, 'plugin tout-en-un utilisé comme ampli');
  assert.match(r.steps.find((s) => s.role === 'cab')!.note!, /déjà inclus/); assert.match(r.steps.find((s) => s.role === 'drive')!.note!, /déjà inclus/);
  assert.equal(r.project.nodes.filter((n) => n.kind === 'plugin').length, 1);
  assert.match(r.steps.find((s) => s.role === 'eq')!.note!, /facultative ignorée/);
});
await test('le plugin tout-en-un choisi est celui pour lequel on a un son ou un preset adapté à la recette', () => {
  const poor = [P('Guitar Rig 7'), P('TONE3000'), P("Blue Cat's Axiom")];
  const st: StatePreset = { id: 's1', name: 'Marshall Bluesbreaker + Neve (amp)', pluginKey: `${poor[1]!.path}|TONE3000`, pluginName: 'TONE3000', chunk: 'QUJD', source: 'x', createdAt: '', keywords: ['clapton', 'blues'] };
  const book = makeBook(null, [st], poor);
  const r = buildFromRecipe(RECIPES.find((x) => x.id === 'clapton')!, poor, HW, book);
  assert.equal(r.steps.find((s) => s.role === 'amp')!.plugin!.name, 'TONE3000');
  assert.equal(r.steps.find((s) => s.role === 'amp')!.preset?.stateId, 's1'); const n = r.project.nodes.find((x) => x.name === 'TONE3000')!; assert.equal(n.chunk, 'QUJD'); assert.equal(n.preset?.kind, 'state');
  // sans rapport avec la recette : aucun preset appliqué
  const idx: PresetIndex = { version: 1, scannedAt: '', roots: [], extensions: [], truncated: false, entries: [{ path: 'C:\\x\\Basse funk.t3kpreset', name: 'Basse funk', ext: 't3kpreset', kind: 'other', vstId: null, classId: null, hints: ['Presets', 'TONE3000'], size: 1 }] };
  const r2 = buildFromRecipe(RECIPES.find((x) => x.id === 'jazz-benson')!, [P('TONE3000')], HW, makeBook(idx, [], [P('TONE3000')]));
  assert.equal(r2.steps.find((s) => s.role === 'amp')!.preset, undefined, 'pas de preset sans mot en commun avec la recette');
});
await test('rôle obligatoire absent : signalé (jamais inventé) ; plugin mono câblé des deux côtés ; synthés exclus ; base vide', () => {
  const r = buildFromRecipe(RECIPES.find((x) => x.id === 'funk-rodgers')!, [P('MCompressor'), P('Kontakt 7', { isSynth: true, audioIns: 0 })], HW);
  assert.deepEqual(r.missing, ['amp']); assert.equal(r.steps.find((s) => s.role === 'amp')!.note, 'aucun plugin de ce type dans votre base');
  const mono = buildFromRecipe(RECIPES.find((x) => x.id === 'jazz-benson')!, [P('Fender Twin Reverb 65', { audioIns: 1, audioOuts: 1 }), P('MReverb')], HW);
  const twin = mono.project.nodes.find((n) => n.name.includes('Twin'))!; assert.equal(mono.project.cables.filter((c) => c.fromNode === twin.id).length, 2, 'sortie mono vers les deux entrées de la réverbération');
  const none = buildFromRecipe(RECIPES[0]!, [], HW); assert.equal(none.ok, false); assert.equal(none.project.nodes.length, 0); assert.deepEqual(none.missing, ['amp']);
});
await test('entrée de la guitare : choix explicite, valeur par défaut « Right » ; recette proposée selon les mots de la demande', () => {
  assert.equal(defaultGuitarInput(HW), 'Right'); assert.equal(defaultGuitarInput({ ...HW, audioIn: ['capture_1', 'capture_2'] }), 'capture_2');
  const r = buildFromRecipe(RECIPES[0]!, FULL, HW, undefined, { guitarInput: 'Left' }); const gi = r.project.nodes.find((n) => n.kind === 'hw-in')!;
  assert.ok(r.project.cables.filter((c) => c.fromNode === gi.id).every((c) => c.fromPort === 'Left'));
  const g = (t: string) => suggestRecipe(t)?.id;
  assert.equal(g('un son jazz à la George Benson'), 'jazz-benson'); assert.equal(g('Bob Marley reggae'), 'reggae'); assert.equal(g('le solo de Junior Marvin'), 'reggae-marvin-rythmique');
  assert.equal(g('Nile Rodgers Le Freak'), 'funk-rodgers'); assert.equal(g('à la Clapton'), 'clapton'); assert.equal(g('The Police, Sting'), 'police-summers'); assert.equal(g('du hard rock'), undefined);
});
await test('Santana « Europa » : amp de type Mesa/Marshall, boost uniquement s\'il ressemble à un Tube Screamer (une fuzz est ignorée), recette proposée pour la demande', () => {
  const rc = RECIPES.find((x) => x.id === 'santana-europa')!;
  const r = buildFromRecipe(rc, FULL, HW);
  assert.equal(r.ok, true); assert.equal(r.steps.find((s) => s.role === 'amp')!.plugin!.name, 'Marshall JTM45');
  assert.match(r.steps.find((s) => s.role === 'drive')!.note!, /aucun plugin adapté dans votre base/, 'Octavia Fuzz n\'est pas un Tube Screamer');
  assert.deepEqual(validateProject(r.project, { requirePluginFiles: false }).filter((x) => x.level === 'error'), []);
  const avecTs = buildFromRecipe(rc, [...FULL, P('Tube Screamer TS808')], HW);
  assert.equal(avecTs.steps.find((s) => s.role === 'drive')!.plugin!.name, 'Tube Screamer TS808');
  assert.equal(avecTs.steps.filter((s) => s.plugin).map((s) => s.role).join('>'), 'comp>drive>amp>eq>delay>reverb', 'ordre du signal');
  const g = (t: string) => suggestRecipe(t)?.id;
  assert.equal(g('un son de Santana, la chanson Europa'), 'santana-europa'); assert.equal(g('Black Magic Woman Carlos Santana'), 'santana-europa'); assert.equal(g('blues à la Clapton'), 'clapton');
  assert.match(rc.tips.join(' '), /Micro manche/);
});
console.log(`\n${ok} tests réussis`);
