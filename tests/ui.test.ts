// Test de l'interface sous jsdom (sans Tauri, IA simulée) : npx tsx tests/ui.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { exportCarxp, importCarxp, type DbPlugin } from '../src/lib/carxp';
import { addPlugin, connect, emptyProject, ensureHardware } from '../src/lib/editor';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
const W = dom.window as unknown as Record<string, unknown>;
for (const k of ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'])
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : W[k], configurable: true, writable: true });

// base de plugins de l'utilisateur (comme après un scan)
const P = (type: string, name: string, over: Record<string, unknown>) => ({ type, name, label: name, maker: 'Éditeur', path: `C:\\VST\\${name}.dll`, uniqueId: 4242, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0, ...over });
dom.window.localStorage.setItem('carlaWiring.db', JSON.stringify([
  P('VST3', 'Guitar Rig 7', { midiIns: 1 }), P('VST2', 'Compresseur 1176', {}), P('VST3', 'Limiteur Live', {}),
  P('VST2', 'Kontakt 7', { isSynth: true, audioIns: 0, audioOuts: 16, midiIns: 1 }),
  P('VST3', 'ReValver', { path: 'C:\\Program Files\\Common Files\\VST3\\ReValver x64.vst3', audioIns: 1, audioOuts: 1 }),
  P('VST3', 'TONE3000', { path: 'C:\\Program Files\\Common Files\\VST3\\TONE3000.vst3\\Contents\\x86_64-win\\TONE3000.vst3' }),
  P('VST3', "Blue Cat's Dynamics 4(Stereo)", { path: "C:\\Program Files\\Common Files\\VST3\\Blue Cat's\\BC Dynamics 4 VST3(Stereo).vst3" }),
]));

const api = await import('../src/lib/api');
await import('../src/main');

const doc = dom.window.document;
const q = <T extends Element>(s: string): T => { const e = doc.querySelector<T>(s); assert.ok(e, 'introuvable : ' + s); return e as T; };
const qa = (s: string) => [...doc.querySelectorAll(s)];
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const click = (el: Element) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const set = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) => { el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
let ok = 0;
const test = async (nom: string, f: () => Promise<void> | void) => { await f(); ok++; console.log('  OK  ' + nom); };

const BON = JSON.stringify({
  name: 'Guitare lead live', summary: 'Ampli, compresseur puis limiteur.', notes: ['Gardez de la marge de niveau'], missing: ['Aucun compteur dans la base'],
  nodes: [{ id: 'n1', plugin: 'p1', role: 'ampli', why: 'son saturé' }, { id: 'n2', plugin: 'p2' }, { id: 'n3', plugin: 'p3', role: 'sécurité' }],
  cables: [
    { from: 'in:capture_1', to: 'n1:input_1' }, { from: 'in:capture_1', to: 'n1:input_2' },
    { from: 'n1:output_1', to: 'n2:input_1' }, { from: 'n1:output_2', to: 'n2:input_2' },
    { from: 'n2:output_1', to: 'n3:input_1' }, { from: 'n2:output_2', to: 'n3:input_2' },
    { from: 'n3:output_1', to: 'out:playback_1' }, { from: 'n3:output_2', to: 'out:playback_2' },
  ],
});
const appels: Array<{ system: string; messages: Array<{ role: string; content: string }> }> = [];
let reponses: string[] = [];
api.setAiTransport(async (_cfg, system, messages) => { appels.push({ system, messages: messages.map((m) => ({ ...m })) }); return reponses.shift() ?? ''; });

await test('6 onglets, Assistant affiché, aucune mention du moteur / ASIO / pont', () => {
  assert.deepEqual(qa('nav button').map((b) => b.textContent), ['Assistant', 'Patchbay', 'Mes chaînes', 'Presets', 'Plugins', 'Aide']);
  assert.equal(q<HTMLElement>('#assistant').hidden, false);
  assert.equal(q<HTMLElement>('#patchbay').hidden, true);
  assert.ok(!/\basio\b|pont python|moteur démarré/i.test(doc.body.textContent ?? ''));
});
await test('sans clé API : message clair, aucun appel à l\'IA', async () => {
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'Guitare lead en live');
  click(q('[data-id=create]')); await tick();
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /clé API/);
  assert.equal(appels.length, 0);
});
await test('création : l\'IA reçoit votre catalogue et vos ports, la chaîne vérifiée arrive avec ses conseils', async () => {
  set(q<HTMLInputElement>('input[type=password]'), 'cle-test');
  reponses = [BON];
  click(q('[data-id=create]')); await tick(120);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.equal(appels.length, 1);
  assert.match(appels[0]!.system, /ingénieur du son/);
  assert.match(appels[0]!.messages[0]!.content, /p1 \| Guitar Rig 7 \| VST3/);
  assert.match(appels[0]!.messages[0]!.content, /capture_1, capture_2/);
  assert.match(appels[0]!.messages[0]!.content, /Guitare lead en live/);
  const res = q<HTMLElement>('[data-id=result]').textContent ?? '';
  assert.match(res, /Guitare lead live/); assert.match(res, /Gardez de la marge/); assert.match(res, /Aucun compteur dans la base/); assert.match(res, /vérifiée en 1 essai/);
  assert.match(q<HTMLElement>('[data-id=log]').textContent ?? '', /valide/);
});
await test('l\'IA se trompe d\'abord (plugin inventé) : les fautes lui sont renvoyées, 2e essai accepté', async () => {
  appels.length = 0;
  reponses = [JSON.stringify({ nodes: [{ id: 'n1', plugin: 'p99' }], cables: [] }), BON];
  click(q('[data-id=create]')); await tick(150);
  assert.equal(appels.length, 2);
  assert.match(appels[1]!.messages[2]!.content, /p99/);
  assert.match(q<HTMLElement>('[data-id=result]').textContent ?? '', /vérifiée en 2 essai/);
});
await test('quota dépassé côté IA : le message du fournisseur s\'affiche, le patchbay reste intact', async () => {
  const avant = q<HTMLElement>('[data-id=counter]').textContent;
  api.setAiTransport(async () => { throw new Error('Quota ou limite de requêtes dépassé (429)'); });
  click(q('[data-id=create]')); await tick();
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Quota/);
  assert.equal(q<HTMLElement>('[data-id=counter]').textContent, avant);
  api.setAiTransport(async (_c, system, messages) => { appels.push({ system, messages }); return reponses.shift() ?? ''; });
});

await test('Patchbay : la chaîne est dessinée (5 boîtes, 8 câbles) et mémorisée', async () => {
  click(q('[data-tab=patchbay]'));
  assert.equal(q<HTMLElement>('#patchbay').hidden, false);
  assert.equal(qa('svg.editor g.node').length, 5);
  assert.equal(qa('svg.editor g.cableg').length, 8);
  assert.match(q<HTMLElement>('[data-id=counter]').textContent ?? '', /5 boîte\(s\) · 8 câble\(s\)/);
  assert.equal(JSON.parse(dom.window.localStorage.getItem('carlaWiring.project') ?? '{}').nodes.length, 5);
});
const node = (name: string) => qa('svg.editor g.node').find((g) => g.querySelector('.gtitle')?.textContent === name)!;
const port = (nodeEl: Element, p: string) => nodeEl.querySelector(`circle[data-port="${p}"]`)!;
await test('double-clic sur un câble : supprimé', () => {
  dom.window.document.querySelector('svg.editor g.cableg')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(qa('svg.editor g.cableg').length, 7);
});
await test('clic sur un port puis sur un autre : câble créé (entrée cliquée en premier acceptée)', () => {
  click(port(node('Audio Input'), 'capture_2')); click(port(node('Guitar Rig 7'), 'input_2'));
  assert.equal(qa('svg.editor g.cableg').length, 8);
  click(port(node('Guitar Rig 7'), 'input_1')); click(port(node('Compresseur 1176'), 'output_1'));
  assert.equal(qa('svg.editor g.cableg').length, 9, 'sens inversé accepté');
});
await test('câble invalide : refusé avec un message, rien n\'est créé', () => {
  const n = qa('svg.editor g.cableg').length;
  click(port(node('Guitar Rig 7'), 'input_1')); click(port(node('Limiteur Live'), 'input_1'));
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /Deux entrées/);
  click(port(node('Guitar Rig 7'), 'output_1')); click(port(node('Guitar Rig 7'), 'events-in'));
  assert.match(q<HTMLElement>('#status').textContent ?? '', /lui-même/);
  assert.equal(qa('svg.editor g.cableg').length, n);
});
await test('clic sur un câble puis touche Suppr : supprimé', () => {
  const n = qa('svg.editor g.cableg').length;
  click(qa('svg.editor g.cableg')[0]!);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal(qa('svg.editor g.cableg').length, n - 1);
});
await test('glisser l\'en-tête d\'une boîte la déplace', () => {
  const g = node('Limiteur Live'); const head = g.querySelector('.ghead')!; const x0 = Number(head.getAttribute('x'));
  head.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
  q('svg.editor').dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 160, clientY: 130 }));
  q('svg.editor').dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(Number(node('Limiteur Live').querySelector('.ghead')!.getAttribute('x')), x0 + 60);
});
await test('⏻ contourne un plugin ; × supprime une boîte et ses câbles ; ajout depuis la base', () => {
  click(node('Compresseur 1176').querySelector('.gbyp')!);
  assert.ok(node('Compresseur 1176').classList.contains('bypass'));
  const cables = qa('svg.editor g.cableg').length;
  click(node('Limiteur Live').querySelector('.gdel')!);
  assert.equal(qa('svg.editor g.node').length, 4);
  assert.ok(qa('svg.editor g.cableg').length < cables);
  set(q<HTMLInputElement>('[data-id=picker]'), 'Kontakt 7'); click(q('[data-id=add]'));
  assert.equal(qa('svg.editor g.node').length, 5);
  assert.equal(node('Kontakt 7').querySelectorAll('circle[data-side=out]').length, 16, 'les 16 sorties du plugin sont là');
  set(q<HTMLInputElement>('[data-id=picker]'), 'Plugin qui n\'existe pas'); click(q('[data-id=add]'));
  assert.match(q<HTMLElement>('#status').textContent ?? '', /pas dans votre base/);
});
await test('les modifications sont mémorisées ; enregistrer hors Tauri = message clair', async () => {
  assert.equal(JSON.parse(dom.window.localStorage.getItem('carlaWiring.project') ?? '{}').nodes.length, 5);
  click(q('[data-id=save]')); await tick();
  assert.equal(q<HTMLElement>('#status').className, 'err');
});
await test('onglet Plugins : la base est affichée', () => {
  click(q('[data-tab=plugins]'));
  assert.match(q<HTMLElement>('[data-id=dbsummary]').textContent ?? '', /7 plugin\(s\)/);
});

// ============ projet existant, annuler/rétablir, vérification, fiche, bibliothèque ============
const xml = readFileSync('tests/fixtures/bluecat_basse.carxp', 'utf-8');
const blocks = (x: string) => x.match(/<Plugin>[\s\S]*?<\/Plugin>/g) ?? [];
const written: Record<string, string> = {};
const extra: Record<string, string> = {};
let openPath: string | null = null;
const hooksSnapshot = {
  pickOpen: async (name) => (name === 'Projet Carla' ? (openPath ?? 'C:\\Users\\Utilisateur\\Music\\bluecat_basse.carxp') : name === 'Mes chaînes' ? 'C:\\out\\mes_chaines.json' : null),
  readTextFile: async (p) => extra[p] ?? (p.endsWith('.carxp') ? xml : written[p] ?? ''),
  pickSave: async (def) => 'C:\\out\\' + def,
  pickFolder: async () => 'C:\\Concert\\scenes',
  writeTextFile: async (p, c) => { written[p] = c; },
  checkPaths: async (paths) => paths.map((p) => !p.includes('TriplePlay')),
};
api.setTestHooks(hooksSnapshot);
const counter = () => q<HTMLElement>('[data-id=counter]').textContent ?? '';
const notices = () => q<HTMLElement>('[data-id=notices]').textContent ?? '';

await test('ouvrir bluecat_basse.carxp : 3 plugins + carte, 9 câbles, ports de la carte repris, fichiers manquants signalés', async () => {
  click(q('[data-tab=patchbay]'));
  click(q('[data-id=open]')); await tick(120);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.match(counter(), /6 boîte\(s\) · 9 câble\(s\)/);
  assert.match(notices(), /Blue Cat's Axiom.*n'est pas dans votre base/);
  assert.match(notices(), /Fichier introuvable : « TriplePlay »/);
  click(q('[data-tab=assistant]'));
  assert.equal(q<HTMLTextAreaElement>('section#assistant textarea:nth-of-type(1)').value.length > 0, true);
  const areas = qa('#assistant textarea').map((t) => (t as HTMLTextAreaElement).value);
  assert.ok(areas.includes('Right\nLeft'), 'sorties de la carte reprises du projet : ' + JSON.stringify(areas));
  click(q('[data-tab=patchbay]'));
});
await test('annuler / rétablir par les boutons et par Ctrl+Z / Ctrl+Y', () => {
  const byp = () => node('LoopRecorder').classList.contains('bypass');
  assert.equal(byp(), false);
  click(node('LoopRecorder').querySelector('.gbyp')!); assert.equal(byp(), true);
  click(q('[data-id=undo]')); assert.equal(byp(), false);
  click(q('[data-id=redo]')); assert.equal(byp(), true);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); assert.equal(byp(), false);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })); assert.equal(byp(), true);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); assert.equal(byp(), false);
  click(q('[data-id=undo]')); click(q('[data-id=undo]')); click(q('[data-id=undo]'));
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Rien à annuler|Annulé/);
});
await test('enregistrer sans modification : les 3 blocs de plugins sont identiques à l\'original, nom proposé _modifie', async () => {
  const hasProject = () => qa('svg.editor g.node').length;
  if (hasProject() !== 6) { click(q('[data-id=open]')); await tick(120); }
  click(q('[data-id=save]')); await tick(120);
  const out = written['C:\\out\\bluecat_basse_modifie.carxp'];
  assert.ok(out, 'fichier écrit sous le nom proposé : ' + Object.keys(written).join(', '));
  assert.deepEqual(blocks(out!), blocks(xml));
  assert.ok(out!.includes('<ExternalPatchbay>') && out!.includes('<BeatsPerMinute>90</BeatsPerMinute>'));
});
await test('contourner un plugin puis enregistrer : seul son <Active> change', async () => {
  click(node('LoopRecorder').querySelector('.gbyp')!);
  click(q('[data-id=save]')); await tick(120);
  const out = blocks(written['C:\\out\\bluecat_basse_modifie.carxp']!);
  assert.equal(out[1], blocks(xml)[1]!.replace('<Active>Yes</Active>', '<Active>No</Active>'));
  assert.equal(out[0], blocks(xml)[0]); assert.equal(out[2], blocks(xml)[2]);
  click(q('[data-id=undo]'));
});
await test('fiche de concert (.md)', async () => {
  click(q('[data-id=sheet]')); await tick(80);
  const md = written['C:\\out\\fiche_chaine.md'] ?? '';
  assert.match(md, /^# bluecat_basse/); assert.match(md, /\*\*LoopRecorder\*\*/); assert.match(md, /## Câblage/);
});
await test('Mes chaînes : enregistrer, vider le patchbay, charger → retrouvé ; dupliquer, exporter, supprimer, importer', async () => {
  click(q('[data-tab=chaines]'));
  set(q<HTMLInputElement>('[data-id=chainname]'), 'Basse concert'); click(q('[data-id=savechain]'));
  assert.equal(qa('[data-chain]').length, 1);
  click(q('[data-tab=patchbay]')); click([...doc.querySelectorAll('.toolbar button')].find((b) => b.textContent === 'Vider')!);
  assert.match(counter(), /0 boîte\(s\) · 0 câble\(s\)/);
  click(q('[data-tab=chaines]')); click(q('[data-chain] [data-id=load]'));
  assert.equal(q<HTMLElement>('#patchbay').hidden, false, 'bascule sur le Patchbay');
  assert.match(counter(), /6 boîte\(s\) · 9 câble\(s\)/);
  click(q('[data-id=undo]')); assert.match(counter(), /0 boîte/, 'le chargement est annulable');
  click(q('[data-id=redo]'));
  click(q('[data-tab=chaines]'));
  click(q('[data-chain] [data-id=dup]')); assert.equal(qa('[data-chain]').length, 2);
  assert.match(q<HTMLElement>('#chaines').textContent ?? '', /Basse concert \(copie\)/);
  click(q('[data-id=exportchains]')); await tick(80);
  assert.equal(JSON.parse(written['C:\\out\\mes_chaines.json']!).chains.length, 2);
  click(qa('[data-chain] [data-id=del]')[0]!); assert.equal(qa('[data-chain]').length, 1);
  click(q('[data-id=importchains]')); await tick(80);
  assert.equal(qa('[data-chain]').length, 3);
  assert.equal(new Set(qa('[data-chain] .t').map((e) => e.firstChild?.textContent)).size, 3, 'aucun nom en double');
  assert.equal(JSON.parse(dom.window.localStorage.getItem('carlaWiring.library') ?? '[]').length, 3);
});
await test('« Modifier la chaîne actuelle » : refus clair si les plugins du patchbay ne sont pas dans la base', async () => {
  click(q('[data-tab=assistant]'));
  const chk = q<HTMLInputElement>('[data-id=modify]'); chk.checked = true; chk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'ajoute un limiteur');
  const avant = appels.length;
  click(q('[data-id=create]')); await tick(80);
  assert.equal(appels.length, avant, 'aucun appel à l\'IA inutile');
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /ne sont pas dans votre base/);
});

// ============ remplacer un plugin, scènes, rig complet ============
await test('⇄ remplacer un plugin : refus tant que le nouveau n\'est pas choisi ; ensuite câbles gardés, réglages non transférés, annulable', async () => {
  click(q('[data-tab=patchbay]')); click(q('[data-id=open]')); await tick(120);
  click(node('LoopRecorder').querySelector('.grep')!);
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Choisissez d'abord le plugin de remplacement/);
  set(q<HTMLInputElement>('[data-id=picker]'), 'Compresseur 1176');
  click(node('LoopRecorder').querySelector('.grep')!);
  assert.ok(node('Compresseur 1176'), 'la boîte porte le nom du nouveau plugin');
  assert.match(notices(), /6 câble\(s\) conservé\(s\)/);
  assert.match(notices(), /réglages sauvegardés de l'ancien plugin ne sont pas transférés/);
  click(q('[data-id=undo]')); assert.ok(node('LoopRecorder'));
});
await test('scènes : deux états enregistrés, rappelés d\'un clic, un .carxp exporté par scène (patchbay actuel inchangé)', async () => {
  const byp = () => node('LoopRecorder').classList.contains('bypass');
  set(q<HTMLInputElement>('[data-id=scenename]'), 'Complet'); click(q('[data-id=scene-save]'));
  click(node('LoopRecorder').querySelector('.gbyp')!);
  set(q<HTMLInputElement>('[data-id=scenename]'), 'Sans loop'); click(q('[data-id=scene-save]'));
  assert.equal(qa('[data-scene]').length, 2);
  click(qa('[data-scene] [data-id=scene-apply]')[0]!); assert.equal(byp(), false);
  click(qa('[data-scene] [data-id=scene-apply]')[1]!); assert.equal(byp(), true);
  click(q('[data-id=scene-export]')); await tick(150);
  const a = written['C:\\Concert\\scenes\\bluecat_basse_Complet.carxp']; const b = written['C:\\Concert\\scenes\\bluecat_basse_Sans loop.carxp'];
  assert.ok(a && b, 'fichiers écrits : ' + Object.keys(written).join(' ; '));
  assert.deepEqual(blocks(a!), blocks(xml));
  assert.equal(blocks(b!)[1], blocks(xml)[1]!.replace('<Active>Yes</Active>', '<Active>No</Active>'));
  assert.equal(byp(), true, 'le patchbay reste dans l\'état où on l\'a laissé');
  assert.match(notices(), /Complet → bluecat_basse_Complet\.carxp/);
});
await test('scènes : suppression annulable ; mémorisées dans Mes chaînes ; « Vider » repart d\'un projet neuf', async () => {
  click(qa('[data-scene] [data-id=scene-del]')[1]!); assert.equal(qa('[data-scene]').length, 1);
  click(q('[data-id=undo]')); assert.equal(qa('[data-scene]').length, 2);
  click(q('[data-tab=chaines]')); set(q<HTMLInputElement>('[data-id=chainname]'), 'Rig scènes'); click(q('[data-id=savechain]'));
  click(q('[data-tab=patchbay]')); click([...doc.querySelectorAll('.toolbar button')].find((b) => b.textContent === 'Vider')!);
  assert.equal(qa('[data-scene]').length, 0); assert.match(counter(), /0 boîte/);
  click(q('[data-tab=chaines]')); click(qa('[data-chain] [data-id=load]').pop()!);
  assert.equal(qa('[data-scene]').length, 2, 'les scènes reviennent avec la chaîne');
});
await test('scènes proposées par l\'IA (variantes par contournement), vérifiées avant d\'être ajoutées', async () => {
  reponses = [JSON.stringify({ scenes: [{ name: 'Propre', bypass: ['n2'], why: 'sans boucle' }, { name: 'Tout', bypass: [] }], notes: ['Changez de scène entre deux morceaux'] })];
  set(q<HTMLInputElement>('[data-id=sceneask]'), 'propre et complet'); click(q('[data-id=scene-ai]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  const noms = qa('[data-scene] [data-id=scene-apply]').map((b) => b.textContent);
  assert.ok(noms.includes('Propre') && noms.includes('Tout'), noms.join(','));
  assert.match(notices(), /Changez de scène entre deux morceaux/);
  reponses = [JSON.stringify({ scenes: [{ name: 'Faux', bypass: ['n99'] }] }), JSON.stringify({ scenes: [{ name: 'Faux', bypass: ['n99'] }] }), JSON.stringify({ scenes: [{ name: 'Faux', bypass: ['n99'] }] })];
  click(q('[data-id=scene-ai]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /3 essais/);
});
await test('exemple « Rig complet » dans l\'Assistant', () => {
  click(q('[data-tab=assistant]'));
  click([...doc.querySelectorAll('.chips button')].find((b) => b.textContent === 'Rig complet')!);
  assert.match(q<HTMLTextAreaElement>('[data-id=request]').value, /Ketron.*mixeur/);
});

// ============ une clé par fournisseur, fournisseur de secours, compteur ============
await test('chaque fournisseur garde SA clé et SON modèle quand on change de fournisseur', () => {
  click(q('[data-tab=assistant]'));
  const prov = q<HTMLSelectElement>('[data-id=provider]'); const key = q<HTMLInputElement>('[data-id=apikey]'); const model = q<HTMLInputElement>('[data-id=model]');
  assert.equal(key.value, 'cle-test'); assert.equal(model.value, 'claude-sonnet-4-6');
  prov.value = 'gemini'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(key.value, ''); assert.equal(model.value, 'gemini-3.8-flash');
  set(key, 'AIza-test'); set(model, 'gemini-3.8-flash-lite');
  prov.value = 'anthropic'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(key.value, 'cle-test'); assert.equal(model.value, 'claude-sonnet-4-6');
  prov.value = 'gemini'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(key.value, 'AIza-test'); assert.equal(model.value, 'gemini-3.8-flash-lite');
  const saved = JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}');
  assert.equal(saved.apiKeys.anthropic, 'cle-test'); assert.equal(saved.apiKeys.gemini, 'AIza-test');
});
await test('Gemini (principal) refuse faute de quota : bascule automatique sur Claude (secours), compteur à jour', async () => {
  const sel = (id: string, v: string) => { const e = q<HTMLSelectElement>(`[data-id=${id}]`); e.value = v; e.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const areas = qa('#assistant textarea').filter((t) => t.getAttribute('data-id') !== 'request') as HTMLTextAreaElement[];
  set(areas[0]!, 'capture_1\ncapture_2'); set(areas[1]!, 'playback_1\nplayback_2'); set(areas[2]!, 'Capture 1');
  const chk = q<HTMLInputElement>('[data-id=modify]'); chk.checked = false; chk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  sel('provider', 'gemini'); sel('backup', 'anthropic');
  const utilises: string[] = [];
  api.setAiTransport(async (cfg, _system, messages) => {
    utilises.push(`${cfg.provider}:${cfg.apiKey}`); appels.push({ system: '', messages });
    if (cfg.provider === 'gemini') throw new Error('Quota ou limite de requêtes dépassé (429) : réessayez plus tard.');
    return BON;
  });
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'guitare lead en live');
  click(q('[data-id=create]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.deepEqual(utilises, ['gemini:AIza-test', 'anthropic:cle-test'], 'chaque fournisseur reçoit sa propre clé');
  assert.match(q<HTMLElement>('[data-id=log]').textContent ?? '', /bascule sur Claude/);
  assert.match(q<HTMLElement>('[data-id=usage]').textContent ?? '', /Gemini [1-9]/);
  assert.match(q<HTMLElement>('[data-id=usage]').textContent ?? '', /Claude [1-9]/);
});
await test('sans clé pour le secours : pas de bascule, l\'erreur de quota est affichée telle quelle', async () => {
  const key = q<HTMLInputElement>('[data-id=apikey]'); // fournisseur affiché : Gemini
  const prov = q<HTMLSelectElement>('[data-id=provider]');
  prov.value = 'anthropic'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true })); set(key, '');
  prov.value = 'gemini'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const b = q<HTMLSelectElement>('[data-id=backup]'); b.value = 'anthropic'; b.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const nb = appels.length;
  click(q('[data-id=create]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Quota/);
  assert.equal(appels.length, nb + 1, 'un seul appel : pas de bascule faute de clé de secours');
  const prov2 = q<HTMLSelectElement>('[data-id=provider]'); prov2.value = 'anthropic'; prov2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLInputElement>('[data-id=apikey]'), 'cle-test');
});
await test('clé manquante pour le fournisseur choisi : message qui nomme le fournisseur', async () => {
  const prov = q<HTMLSelectElement>('[data-id=provider]'); prov.value = 'openai'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const nb = appels.length;
  click(q('[data-id=create]')); await tick(60);
  assert.match(q<HTMLElement>('#status').textContent ?? '', /clé API de ChatGPT/);
  assert.equal(appels.length, nb);
});

// ============ Ollama (IA locale, sans clé) ============
await test('Ollama : pas de clé demandée, champs adresse/contexte affichés, la requête part avec l\'adresse et le contexte réglés', async () => {
  click(q('[data-tab=assistant]'));
  const prov = q<HTMLSelectElement>('[data-id=provider]');
  prov.value = 'ollama'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(q<HTMLElement>('[data-id=ollama-fields]').hidden, false);
  assert.equal(q<HTMLInputElement>('[data-id=apikey]').closest('div')?.hidden, true, 'champ clé masqué');
  assert.equal(q<HTMLInputElement>('[data-id=model]').value, 'qwen2.5:7b');
  const bk = q<HTMLSelectElement>('[data-id=backup]'); bk.value = ''; bk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLInputElement>('[data-id=ollamactx]'), '20480');
  const vus: Array<Record<string, unknown>> = [];
  api.setAiTransport(async (cfg, _s, messages) => { vus.push({ ...cfg }); appels.push({ system: '', messages }); return BON; });
  const chk = q<HTMLInputElement>('[data-id=modify]'); chk.checked = false; chk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'guitare lead en live');
  click(q('[data-id=create]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.equal(vus.length, 1);
  assert.equal(vus[0]!.provider, 'ollama'); assert.equal(vus[0]!.apiKey, ''); assert.equal(vus[0]!.baseUrl, 'http://localhost:11434'); assert.equal(vus[0]!.numCtx, 20480);
  assert.match(q<HTMLElement>('[data-id=usage]').textContent ?? '', /Ollama 1/);
});
await test('Ollama sans nom de modèle : message clair ; retour à un fournisseur en ligne : le champ clé réapparaît', async () => {
  set(q<HTMLInputElement>('[data-id=model]'), '');
  const nb = appels.length; click(q('[data-id=create]')); await tick(60);
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /nom du modèle Ollama/); assert.equal(appels.length, nb);
  set(q<HTMLInputElement>('[data-id=model]'), 'qwen2.5:7b');
  const prov = q<HTMLSelectElement>('[data-id=provider]'); prov.value = 'anthropic'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(q<HTMLElement>('[data-id=ollama-fields]').hidden, true);
  assert.equal(q<HTMLInputElement>('[data-id=apikey]').closest('div')?.hidden, false);
});
await test('Ollama en secours (sans clé) : quota Claude atteint → bascule sur le modèle local', async () => {
  const sel = (id: string, v: string) => { const e = q<HTMLSelectElement>(`[data-id=${id}]`); e.value = v; e.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  sel('provider', 'anthropic'); sel('backup', 'ollama');
  const ordre: string[] = [];
  api.setAiTransport(async (cfg, _s, messages) => { ordre.push(cfg.provider); appels.push({ system: '', messages }); if (cfg.provider === 'anthropic') throw new Error('Quota ou limite de requêtes dépassé (429)'); return BON; });
  click(q('[data-id=create]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.deepEqual(ordre, ['anthropic', 'ollama']);
  assert.match(q<HTMLElement>('[data-id=log]').textContent ?? '', /bascule sur Ollama/);
  // et si Ollama n'est pas lancé : l'erreur dit quoi faire
  api.setAiTransport(async (cfg) => { throw new Error(cfg.provider === 'ollama' ? 'Ollama ne répond pas sur http://localhost:11434 : lancez l\'application Ollama' : 'Quota ou limite de requêtes dépassé (429)'); });
  click(q('[data-id=create]')); await tick(150);
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /Ollama ne répond pas/);
});

await test('Ollama : réglage « Plugins envoyés au modèle » (100 par défaut) et temps écoulé affiché pendant l\'attente', async () => {
  click(q('[data-tab=assistant]'));
  const prov = q<HTMLSelectElement>('[data-id=provider]'); prov.value = 'ollama'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(q<HTMLInputElement>('[data-id=ollamamax]').value, '100');
  set(q<HTMLInputElement>('[data-id=ollamamax]'), '60');
  assert.equal(JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}').ollamaMaxPlugins, 60);
  api.setAiTransport(async () => { await new Promise((r) => setTimeout(r, 2300)); return BON; });
  const bk = q<HTMLSelectElement>('[data-id=backup]'); bk.value = ''; bk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'guitare lead en live');
  click(q('[data-id=create]')); await tick(1500);
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Création de la chaîne… [12] s/, q<HTMLElement>('#status').textContent ?? '');
  assert.equal(q<HTMLButtonElement>('[data-id=create]').disabled, true, 'bouton bloqué pendant l\'attente');
  await tick(1600);
  assert.equal(q<HTMLElement>('#status').className, 'ok');
  assert.match(q<HTMLElement>('[data-id=log]').textContent ?? '', /réponse reçue en [0-9]+ s/);
});

// ============ Patchbay : câbles tirés à la souris, sélection, couleurs, organisation, zoom ============
const mouse = (type: string, init: Record<string, unknown> = {}) => new dom.window.MouseEvent(type, { bubbles: true, ...init });
const svgEl = () => q<SVGElement>('svg.editor');
const nodeId = (name: string) => node(name).getAttribute('data-node')!;
const toolbarBtn = (label: string) => [...doc.querySelectorAll('.toolbar button')].find((b) => b.textContent === label)!;
const addByPicker = (name: string) => { set(q<HTMLInputElement>('[data-id=picker]'), name); click(q('[data-id=add]')); };

await test('TIRER un câble entre deux ports (appuyer, glisser, relâcher) ; refus d\'un câble invalide ; relâcher dans le vide = rien', () => {
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider'));
  addByPicker('Guitar Rig 7'); addByPicker('Compresseur 1176'); click(toolbarBtn('+ Entrée carte')); click(toolbarBtn('+ Sortie carte'));
  assert.equal(qa('svg.editor g.cableg').length, 0);
  const drag = (a: Element, b: Element | null) => {
    a.dispatchEvent(mouse('mousedown', { clientX: 10, clientY: 10 }));
    svgEl().dispatchEvent(mouse('mousemove', { clientX: 60, clientY: 40 }));
    assert.ok(svgEl().querySelector('.templink'), 'trait de visée affiché pendant le glissement');
    (b ?? svgEl()).dispatchEvent(mouse('mouseup', { clientX: 60, clientY: 40 }));
  };
  const gr = node('Guitar Rig 7'), co = node('Compresseur 1176');
  // pendant l'appui, les ports incompatibles s'estompent
  port(gr, 'output_1').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 }));
  assert.ok(port(gr, 'input_1').classList.contains('dim') && !port(co, 'input_1').classList.contains('dim'));
  svgEl().dispatchEvent(mouse('mouseup', { clientX: 1, clientY: 1 }));
  drag(port(gr, 'output_1'), port(co, 'input_1'));
  assert.equal(qa('svg.editor g.cableg').length, 1, 'câble créé en glissant');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Câble créé/);
  drag(port(node('Audio Input'), 'capture_1'), port(node('Guitar Rig 7'), 'input_1'));
  drag(port(node('Compresseur 1176'), 'input_2'), port(node('Guitar Rig 7'), 'output_2'));    // de l'entrée vers la sortie : accepté
  drag(port(node('Compresseur 1176'), 'output_1'), port(node('Audio Output'), 'playback_1'));
  assert.equal(qa('svg.editor g.cableg').length, 4);
  drag(port(node('Guitar Rig 7'), 'output_1'), port(node('Guitar Rig 7'), 'events-in'));       // même plugin
  assert.match(q<HTMLElement>('#status').textContent ?? '', /lui-même/);
  drag(port(node('Guitar Rig 7'), 'input_2'), port(node('Compresseur 1176'), 'input_2'));     // deux entrées
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Deux entrées/);
  drag(port(node('Guitar Rig 7'), 'output_2'), null);                                          // relâché sur le fond
  assert.equal(qa('svg.editor g.cableg').length, 4);
  assert.equal(svgEl().querySelector('.templink'), null, 'le trait de visée disparaît');
  assert.equal(svgEl().querySelector('.dim'), null);
  click(q('[data-id=undo]')); assert.equal(qa('svg.editor g.cableg').length, 3, 'annulable');
});
await test('sélection multiple : Maj+clic, cadre, Ctrl+A ; déplacement groupé ; Suppr ; panneau Sélection', () => {
  const head = (name: string) => node(name).querySelector('.ghead')!;
  head('Guitar Rig 7').dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5 })); svgEl().dispatchEvent(mouse('mouseup'));
  assert.equal(qa('svg.editor g.node.sel').length, 1);
  assert.match(q<HTMLElement>('[data-id=selpanel]').textContent ?? '', /Guitar Rig 7/);
  head('Compresseur 1176').dispatchEvent(mouse('mousedown', { shiftKey: true, clientX: 5, clientY: 5 }));
  assert.equal(qa('svg.editor g.node.sel').length, 2); assert.match(q<HTMLElement>('[data-id=selpanel]').textContent ?? '', /2 boîtes sélectionnées/);
  const x = (n: string) => Number(node(n).querySelector('.ghead')!.getAttribute('x'));
  const [a0, b0] = [x('Guitar Rig 7'), x('Compresseur 1176')];
  head('Guitar Rig 7').dispatchEvent(mouse('mousedown', { clientX: 100, clientY: 100 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: 140, clientY: 100 })); svgEl().dispatchEvent(mouse('mouseup'));
  assert.equal(x('Guitar Rig 7'), a0 + 40); assert.equal(x('Compresseur 1176'), b0 + 40, 'les deux boîtes sélectionnées bougent ensemble');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(qa('svg.editor g.node.sel').length, 0, 'Échap désélectionne');
  svgEl().dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: 4000, clientY: 4000 })); svgEl().dispatchEvent(mouse('mouseup', { clientX: 4000, clientY: 4000 }));
  assert.equal(qa('svg.editor g.node.sel').length, 4, 'le cadre sélectionne toutes les boîtes touchées');
  svgEl().dispatchEvent(mouse('click')); assert.equal(qa('svg.editor g.node.sel').length, 4, 'le clic qui suit le cadre ne désélectionne pas');
  svgEl().dispatchEvent(mouse('mousedown')); svgEl().dispatchEvent(mouse('mouseup')); svgEl().dispatchEvent(mouse('click'));
  assert.equal(qa('svg.editor g.node.sel').length, 0, 'clic sur le fond = désélection');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  assert.equal(qa('svg.editor g.node.sel').length, 4, 'Ctrl+A');
});
await test('couleur d\'une boîte, alignement, répartition ; Suppr efface la sélection (annulable)', () => {
  head2('Guitar Rig 7').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 })); svgEl().dispatchEvent(mouse('mouseup'));
  const sw = qa('[data-id=swatch]'); assert.equal(sw.length, 8);
  click(sw[3]!);
  assert.match(node('Guitar Rig 7').querySelector('.ghead')!.getAttribute('style') ?? '', /fill:#f472b6/);
  assert.match(node('Guitar Rig 7').querySelector('.gnode')!.getAttribute('style') ?? '', /stroke:#f472b6/);
  assert.equal(node('Compresseur 1176').querySelector('.ghead')!.getAttribute('style'), null, 'les autres boîtes gardent leur couleur');
  click(q('[data-id=color-reset]')); assert.equal(node('Guitar Rig 7').querySelector('.ghead')!.getAttribute('style'), null);
  // alignement de deux boîtes
  head2('Compresseur 1176').dispatchEvent(mouse('mousedown', { shiftKey: true, clientX: 1, clientY: 1 }));
  click(q('[data-id=align-top]'));
  const y = (n: string) => Number(node(n).querySelector('.ghead')!.getAttribute('y'));
  assert.equal(y('Guitar Rig 7'), y('Compresseur 1176'));
  click(q('[data-id=align-left]')); const xx = (n: string) => Number(node(n).querySelector('.ghead')!.getAttribute('x'));
  assert.equal(xx('Guitar Rig 7'), xx('Compresseur 1176'));
  click(q('[data-id=dist-x]')); assert.match(q<HTMLElement>('#status').textContent ?? '', /au moins 3 boîtes/);
  const n = qa('svg.editor g.node').length;
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal(qa('svg.editor g.node').length, n - 2, 'les 2 boîtes sélectionnées sont supprimées');
  click(q('[data-id=undo]')); assert.equal(qa('svg.editor g.node').length, n);
});
function head2(name: string) { return node(name).querySelector('.ghead')!; }
await test('zoom et centrage de la vue', () => {
  click(q('[data-id=zoom-in]')); assert.equal(q<HTMLElement>('[data-id=zoom]').textContent, '110 %');
  assert.equal(svgEl().getAttribute('viewBox')?.split(' ').length, 4);
  click(q('[data-id=zoom-out]')); click(q('[data-id=zoom-out]')); assert.equal(q<HTMLElement>('[data-id=zoom]').textContent, '90 %');
  click(q('[data-id=zoom-reset]')); assert.equal(q<HTMLElement>('[data-id=zoom]').textContent, '100 %');
  click(q('[data-id=center-view]')); // ne doit pas planter
  for (let i = 0; i < 15; i++) click(q('[data-id=zoom-out]'));
  assert.equal(q<HTMLElement>('[data-id=zoom]').textContent, '40 %', 'zoom minimal');
  click(q('[data-id=zoom-reset]'));
});

// ============ Presets : sons capturés, choix dans le panneau, injection dans le .carxp, export centré ============
const GR: DbPlugin = { type: 'VST3', name: 'Guitar Rig 7', label: 'Guitar Rig 7', maker: 'Éditeur', path: 'C:\\VST\\Guitar Rig 7.dll', uniqueId: 4242, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 1, midiOuts: 0 };
const sonProj = emptyProject({ name: 'c', audioIn: ['capture_1'], audioOut: ['playback_1'], midiIn: [] });
{ const n = addPlugin(sonProj, GR); n.chunk = 'U09OX0NBUFRVUkU='; const i = ensureHardware(sonProj, 'hw-in'); const o = ensureHardware(sonProj, 'hw-out');
  connect(sonProj, { node: i.id, port: 'capture_1' }, { node: n.id, port: 'input_1' }); connect(sonProj, { node: n.id, port: 'output_1' }, { node: o.id, port: 'playback_1' }); }
extra['C:\\Sons\\lead_jazz.carxp'] = exportCarxp(sonProj, true);

await test('Presets : scan hors application = message clair ; capture d\'un son depuis un projet Carla', async () => {
  click(q('[data-tab=presets]'));
  click(q('[data-id=scan-presets]')); await tick();
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /application Carla Wiring/);
  click(q('[data-id=scan-ext]')); await tick(); assert.equal(q<HTMLElement>('#status').className, 'err');
  openPath = 'C:\\Sons\\lead_jazz.carxp';
  click(q('[data-id=capture-project]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.equal(qa('[data-state]').length, 1);
  assert.equal(q<HTMLInputElement>('[data-state] input').value, 'Guitar Rig 7 – lead_jazz', 'nom modifiable');
  assert.match(q<HTMLElement>('[data-state]').textContent ?? '', /Guitar Rig 7 — depuis « lead_jazz »/);
  click(q('[data-id=capture-project]')); await tick(100);
  assert.equal(qa('[data-state]').length, 1, 'le même son n\'est pas ajouté deux fois');
  assert.match(q<HTMLElement>('[data-id=presetsummary]').textContent ?? '', /1 son\(s\) capturé\(s\)/);
  assert.match(JSON.stringify(JSON.parse(dom.window.localStorage.getItem('carlaWiring.store.states') ?? '[]')), /U09OX0NBUFRVUkU=/, 'mémorisé');
  openPath = null;
});
await test('Presets : le son capturé est proposé dans le panneau d\'un plugin, appliqué, puis écrit dans le .carxp', async () => {
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider')); addByPicker('Guitar Rig 7'); click(toolbarBtn('+ Entrée carte')); click(toolbarBtn('+ Sortie carte'));
  head2('Guitar Rig 7').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 })); svgEl().dispatchEvent(mouse('mouseup'));
  const pick = q<HTMLSelectElement>('[data-id=presetpick]');
  assert.match(pick.textContent ?? '', /\[son capturé\] Guitar Rig 7 – lead_jazz/);
  pick.value = '0'; pick.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(node('Guitar Rig 7').textContent ?? '', /♪ Guitar Rig 7 – lead_jazz \(appliqué\)/);
  drag2(port(node('Audio Input'), 'capture_1'), port(node('Guitar Rig 7'), 'input_1')); drag2(port(node('Guitar Rig 7'), 'output_1'), port(node('Audio Output'), 'playback_1'));
  click(q('[data-id=save]')); await tick(100);
  const out = written['C:\\out\\ma_chaine.carxp']; assert.ok(out, Object.keys(written).join(' ; '));
  assert.equal(importCarxp(out!).plugins[0]!.chunk, 'U09OX0NBUFRVUkU=', 'l\'état du son capturé est dans le fichier');
  // export centré : la carte son a une position, tout est dans le canevas de Carla
  const pos = [...out!.matchAll(/<Position x1="(\d+)" y1="(\d+)"[^>]*>\s*<Name>([^<]*)/g)].map((m) => ({ x: +m[1]!, y: +m[2]!, n: m[3]! }));
  assert.deepEqual(pos.map((p) => p.n).sort(), ['Audio Input', 'Audio Output', 'Guitar Rig 7']);
  assert.ok(pos.every((p) => p.x >= 0 && p.x < 3100 && p.y >= 0 && p.y < 2400));
  assert.ok(Math.abs((Math.min(...pos.map((p) => p.x)) + Math.max(...pos.map((p) => p.x)) + 210) / 2 - 1550) < 3, 'centré sur le canevas de Carla');
  // sans centrage : pas de position pour la carte son
  click(q('[data-id=center-carla]')); click(q('[data-id=save]')); await tick(100);
  const brut = written['C:\\out\\ma_chaine.carxp']!;
  assert.doesNotMatch(brut, /<Name>Audio Input<\/Name>/); click(q('[data-id=center-carla]'));
  // retirer le preset
  head2('Guitar Rig 7').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 })); svgEl().dispatchEvent(mouse('mouseup'));
  click(q('[data-id=preset-clear]')); assert.doesNotMatch(node('Guitar Rig 7').textContent ?? '', /♪/);
});
function drag2(a: Element, b: Element) {
  a.dispatchEvent(mouse('mousedown', { clientX: 10, clientY: 10 })); svgEl().dispatchEvent(mouse('mousemove', { clientX: 60, clientY: 40 })); b.dispatchEvent(mouse('mouseup', { clientX: 60, clientY: 40 }));
}
await test('Assistant : les sons capturés sont proposés à l\'IA, qui peut en choisir un (vérifié) ; l\'option se désactive', async () => {
  click(q('[data-tab=assistant]'));
  const prov = q<HTMLSelectElement>('[data-id=provider]'); prov.value = 'anthropic'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLInputElement>('[data-id=apikey]'), 'cle-test');
  const bk = q<HTMLSelectElement>('[data-id=backup]'); bk.value = ''; bk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const chk = q<HTMLInputElement>('[data-id=modify]'); chk.checked = false; chk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(q<HTMLElement>('[data-id=presetinfo]').textContent ?? '', /1 son\(s\) capturé\(s\)/);
  let prompt = '';
  const reponse = JSON.stringify({ name: 'Lead jazz', summary: 'x', nodes: [{ id: 'n1', plugin: 'p1', preset: 's1' }],
    cables: [{ from: 'in:capture_1', to: 'n1:input_1' }, { from: 'n1:output_1', to: 'out:playback_1' }] });
  api.setAiTransport(async (_c, _s, m) => { prompt = m[0]?.content ?? ''; return reponse; });
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'guitare jazz');
  click(q('[data-id=create]')); await tick(150);
  assert.match(prompt, /PRESETS DISPONIBLES[\s\S]*p1 \(Guitar Rig 7\) : s1 « Guitar Rig 7 – lead_jazz » \[son capturé\]/);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.match(q<HTMLElement>('[data-id=result]').textContent ?? '', /Preset : Guitar Rig 7 – lead_jazz \(appliqué automatiquement\)/);
  const pc = q<HTMLInputElement>('[data-id=usepresets]'); pc.checked = false; pc.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  click(q('[data-id=create]')); await tick(150);
  assert.doesNotMatch(prompt, /PRESETS DISPONIBLES/, 'option décochée : aucun preset envoyé');
});

await test('Presets : découverte automatique par plugin, formats classés, un clic pour utiliser un dossier', async () => {
  click(q('[data-tab=presets]'));
  api.setTestHooks({ ...hooksSnapshot, discoverPresetDirs: async (hints, roots) => {
    assert.ok(hints.includes('guitarrig7'), 'les noms de vos plugins sont transmis : ' + hints.join()); void roots;
    return [{ path: 'C:\\Users\\Utilisateur\\AppData\\Roaming\\MeldaProduction\\MeldaProduction MXXX', name: 'MeldaProduction MXXX', files: 60,
      exts: [{ ext: 'mpreset', count: 40, example: 'a' }, { ext: 'winstate', count: 12, example: 'b' }, { ext: 'xyz', count: 8, example: 'c' }] },
    { path: 'C:\\ProgramData\\Guitar Rig 7', name: 'Guitar Rig 7', files: 5, exts: [{ ext: 'fxp', count: 5, example: 'd' }] }]; } });
  click(q('[data-id=discover]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.equal(qa('[data-dir]').length, 2);
  const melda = q<HTMLElement>('[data-dir*="MXXX"]');
  assert.match(melda.textContent ?? '', /\.mpreset ×40/); assert.match(melda.textContent ?? '', /\.winstate ×12/);
  assert.match(q<HTMLElement>('[data-dir*="Guitar Rig 7"]').textContent ?? '', /Guitar Rig 7/, 'rattaché au plugin de la base');
  assert.ok(melda.querySelector('.tag.warn'), 'format inconnu en jaune'); assert.ok(melda.querySelector('.tag.ok'));
  click(melda.querySelector('[data-id=disc-use]')!);
  const settings = () => JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}');
  assert.match(settings().presetRoots, /MeldaProduction MXXX/); assert.match(settings().presetExts, /mpreset/);
  assert.doesNotMatch(settings().presetExts, /winstate|xyz/, 'ni le bruit ni le format inconnu ne sont ajoutés tout seuls');
  click(melda.querySelector('[data-id=disc-ext]')!); assert.match(settings().presetExts, /xyz/, 'ajout explicite d\'un format à vérifier');
  click(q('[data-id=disc-all]')); assert.match(settings().presetRoots, /Guitar Rig 7/); assert.match(settings().presetExts, /fxp/);
  assert.equal(settings().presetMode, 'dossiers');
  api.setTestHooks(hooksSnapshot);
});
await test('Presets : découverte sans plugin scanné ou hors application = message clair', async () => {
  api.setTestHooks({ ...hooksSnapshot, discoverPresetDirs: undefined });
  click(q('[data-id=discover]')); await tick(60);
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /application Carla Wiring/);
  api.setTestHooks(hooksSnapshot);
});

// ============ câble souple et aimanté ============
await test('câble : fil SOUPLE (courbe), port visé mis en évidence, aimantation à proximité, rien si trop loin', () => {
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider'));
  addByPicker('Guitar Rig 7'); addByPicker('Compresseur 1176');
  const gr = node('Guitar Rig 7'), co = node('Compresseur 1176');
  const at = (el: Element) => ({ x: Number(el.getAttribute('cx')), y: Number(el.getAttribute('cy')) });
  const target = at(port(co, 'input_1'));
  // 1) relâché À CÔTÉ du port (≈ 20 px) sur le fond : le câble s'aimante
  port(gr, 'output_1').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: target.x - 20, clientY: target.y + 8 }));
  const fil = svgEl().querySelector('path.templink'); assert.ok(fil, 'fil de visée');
  assert.match(fil!.getAttribute('d') ?? '', /^M[\d.]+,[\d.]+ C/, 'courbe de Bézier, pas une droite');
  assert.ok(port(co, 'input_1').classList.contains('snap'), 'le port visé est mis en évidence');
  assert.match(fil!.getAttribute('d') ?? '', new RegExp(`${target.x},${target.y}$`), 'le fil se colle au port aimanté');
  svgEl().dispatchEvent(mouse('mouseup', { clientX: target.x - 20, clientY: target.y + 8 }));
  assert.equal(qa('svg.editor g.cableg').length, 1, 'câble créé sans viser pile sur le port');
  // 2) relâché TROP LOIN : rien
  port(gr, 'output_2').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: target.x - 200, clientY: target.y + 250 }));
  assert.equal(svgEl().querySelector('.port.snap'), null, 'rien à portée : pas de port aimanté');
  svgEl().dispatchEvent(mouse('mouseup', { clientX: target.x - 200, clientY: target.y + 250 }));
  assert.equal(qa('svg.editor g.cableg').length, 1);
  assert.equal(svgEl().querySelector('.snap'), null); assert.equal(svgEl().querySelector('.templink'), null);
});
await test('câble : relâcher SUR une boîte la relie à son port compatible le plus proche (audio vers audio, jamais vers le MIDI)', () => {
  const gr = node('Guitar Rig 7'), co = node('Compresseur 1176');
  const box = co.querySelector('rect.gnode')!; const bx = Number(box.getAttribute('x')), by = Number(box.getAttribute('y')), bh = Number(box.getAttribute('height'));
  port(gr, 'output_2').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: bx + 100, clientY: by + bh - 4 }));
  box.dispatchEvent(mouse('mouseup', { clientX: bx + 100, clientY: by + bh - 4 }));
  assert.equal(qa('svg.editor g.cableg').length, 2);
  // une sortie audio lâchée sur une boîte qui n'a que des entrées audio + une entrée MIDI : l'entrée MIDI n'est jamais choisie
  port(gr, 'output_1').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: bx + 100, clientY: by + 50 }));
  const snapped = svgEl().querySelector('.port.snap');
  assert.ok(snapped && snapped.classList.contains('audio'), 'cible audio');
  svgEl().dispatchEvent(mouse('mouseup', { clientX: bx + 100, clientY: by + 50 }));
});
await test('câble : la zone de saisie élargie de la ligne du port suffit pour commencer et finir un câble', () => {
  click(toolbarBtn('Vider')); addByPicker('Guitar Rig 7'); addByPicker('Compresseur 1176');
  const gr = node('Guitar Rig 7'), co = node('Compresseur 1176');
  const hit = (n: Element, p: string) => n.querySelector(`rect.porthit[data-port="${p}"]`)!;
  assert.ok(hit(gr, 'output_1').getAttribute('width') && Number(hit(gr, 'output_1').getAttribute('width')) > 60, 'zone large, pas juste le rond');
  hit(gr, 'output_1').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 }));
  svgEl().dispatchEvent(mouse('mousemove', { clientX: 400, clientY: 90 }));
  hit(co, 'input_2').dispatchEvent(mouse('mouseup', { clientX: 400, clientY: 90 }));
  assert.equal(qa('svg.editor g.cableg').length, 1);
  // clic simple (sans glisser) sur la zone : mode clic-clic toujours possible
  hit(gr, 'output_2').dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5 })); svgEl().dispatchEvent(mouse('mouseup', { clientX: 5, clientY: 5 })); click(hit(gr, 'output_2'));
  click(hit(co, 'input_1'));
  assert.equal(qa('svg.editor g.cableg').length, 2);
});

// ============ palette de couleur sur chaque boîte ============
await test('couleur : le point de la boîte ouvre sa palette ; choix = cadre coloré, point rempli, palette refermée', () => {
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider')); addByPicker('Guitar Rig 7'); addByPicker('Compresseur 1176');
  const dot = (name: string) => node(name).querySelector('circle.gcolor')!;
  assert.ok(dot('Guitar Rig 7'), 'chaque boîte a son point de couleur'); assert.equal(dot('Guitar Rig 7').getAttribute('style'), null, 'anneau vide = couleur par défaut');
  assert.equal(doc.querySelector('[data-id=colorpop]'), null);
  dot('Guitar Rig 7').dispatchEvent(mouse('click', { clientX: 200, clientY: 120 }));
  const pop = q<HTMLElement>('[data-id=colorpop]');
  assert.match(pop.textContent ?? '', /Couleur de « Guitar Rig 7 »/); assert.equal(pop.querySelectorAll('[data-id=pop-swatch]').length, 8);
  click(pop.querySelectorAll('[data-id=pop-swatch]')[2]!);
  assert.equal(doc.querySelector('[data-id=colorpop]'), null, 'palette refermée après le choix');
  assert.match(node('Guitar Rig 7').querySelector('.gnode')!.getAttribute('style') ?? '', /stroke:#fbbf24;stroke-width:2\.8/, 'cadre coloré et épais');
  assert.match(dot('Guitar Rig 7').getAttribute('style') ?? '', /fill:#fbbf24/, 'le point montre la couleur');
  assert.equal(node('Compresseur 1176').querySelector('.gnode')!.getAttribute('style'), null, 'les autres boîtes ne changent pas');
  click(q('[data-id=undo]')); assert.equal(node('Guitar Rig 7').querySelector('.gnode')!.getAttribute('style'), null, 'annulable');
});
await test('couleur : couleur libre, par défaut, fermeture par clic ailleurs et par Échap ; sélection multiple colorée d\'un coup', async () => {
  const dot = (name: string) => node(name).querySelector('circle.gcolor')!;
  dot('Compresseur 1176').dispatchEvent(mouse('click', { clientX: 300, clientY: 200 }));
  const custom = q<HTMLInputElement>('[data-id=pop-custom]'); custom.value = '#12ab34'; custom.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(node('Compresseur 1176').querySelector('.gnode')!.getAttribute('style') ?? '', /stroke:#12ab34/);
  dot('Compresseur 1176').dispatchEvent(mouse('click', { clientX: 300, clientY: 200 })); click(q('[data-id=pop-reset]'));
  assert.equal(node('Compresseur 1176').querySelector('.gnode')!.getAttribute('style'), null);
  dot('Compresseur 1176').dispatchEvent(mouse('click', { clientX: 300, clientY: 200 })); await tick(10);
  doc.body.dispatchEvent(mouse('mousedown')); assert.equal(doc.querySelector('[data-id=colorpop]'), null, 'clic ailleurs : fermée');
  dot('Compresseur 1176').dispatchEvent(mouse('click', { clientX: 300, clientY: 200 }));
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(doc.querySelector('[data-id=colorpop]'), null, 'Échap : fermée');
  // les deux boîtes sélectionnées : une couleur pour toutes
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  dot('Guitar Rig 7').dispatchEvent(mouse('click', { clientX: 200, clientY: 120 }));
  assert.match(q<HTMLElement>('[data-id=colorpop]').textContent ?? '', /Couleur des 2 boîtes sélectionnées/);
  click(q('[data-id=colorpop]').querySelectorAll('[data-id=pop-swatch]')[4]!);
  for (const n of ['Guitar Rig 7', 'Compresseur 1176']) assert.match(node(n).querySelector('.gnode')!.getAttribute('style') ?? '', /stroke:#a78bfa/);
});
await test('couleurs par rôle (instruments / effets / carte son) puis effacement', () => {
  click(toolbarBtn('Vider')); addByPicker('Kontakt 7'); addByPicker('Compresseur 1176'); click(toolbarBtn('+ Entrée carte'));
  click(q('[data-id=color-role]'));
  const stroke = (n: string) => /stroke:(#[0-9a-f]{6})/.exec(node(n).querySelector('.gnode')!.getAttribute('style') ?? '')?.[1];
  assert.equal(stroke('Kontakt 7'), '#fbbf24'); assert.equal(stroke('Compresseur 1176'), '#22d3ee'); assert.equal(stroke('Audio Input'), '#8b97a5');
  click(q('[data-id=color-clear]')); assert.equal(stroke('Kontakt 7'), undefined);
});

await test('noms longs : coupés avec « … » selon la largeur mesurée (jamais sous les boutons), nom complet gardé', () => {
  const proto = (dom.window as any).SVGElement.prototype;
  proto.getComputedTextLength = function (this: Element) { return (this.textContent ?? '').length * 8; };
  try {
    click(toolbarBtn('Vider')); addByPicker('Compresseur 1176');
    const t = svgEl().querySelector('text.gtitle[data-full="Compresseur 1176"]')!;
    assert.ok(t.textContent!.endsWith('…'), t.textContent ?? ''); assert.ok(t.textContent!.length * 8 <= Number(t.getAttribute('data-max')) + 8);
    assert.equal(t.getAttribute('data-full'), 'Compresseur 1176');
    click(toolbarBtn('+ Entrée carte')); const hw = svgEl().querySelector('text.gtitle[data-full="Audio Input"]')!;
    assert.equal(hw.textContent, 'Audio Input', 'un nom court n\'est pas modifié');
  } finally { delete proto.getComputedTextLength; }
});

await test('Presets : « Analyser un dossier » détaille chaque sous-dossier (composants de Guitar Rig) et permet d\'en utiliser un', async () => {
  click(q('[data-tab=presets]'));
  const root = 'C:\\Program Files\\Common Files\\Native Instruments\\Guitar Rig 7\\Content';
  const sett = () => JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}');
  set(q<HTMLTextAreaElement>('#presets textarea'), root);
  const seen: string[] = [];
  api.setTestHooks({ ...hooksSnapshot,
    scanExtensions: async (f) => { seen.push('ext:' + f); return [{ ext: 'ncw', count: 210, example: 'x' }, { ext: 'ngrr', count: 30, example: 'y' }, { ext: 'wav', count: 2, example: 'z' }]; },
    analyseSubfolders: async (f) => { seen.push('sub:' + f); return [
      { name: 'Reflektor', path: `${root}\\Reflektor`, files: 40, exts: [{ ext: 'ngrr', count: 30, example: 'a' }, { ext: 'ncw', count: 10, example: 'b' }] },
      { name: 'Matched Cabinet Pro', path: `${root}\\Matched Cabinet Pro`, files: 200, exts: [{ ext: 'ncw', count: 200, example: 'c' }] },
      { name: 'Metronome', path: `${root}\\Metronome`, files: 2, exts: [{ ext: 'wav', count: 2, example: 'd' }] }]; } });
  click(q('[data-id=scan-ext]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.deepEqual(seen, ['ext:' + root, 'sub:' + root]);
  assert.equal(qa('[data-sub]').length, 3);
  const refl = q<HTMLElement>('[data-sub="Reflektor"]');
  assert.ok(refl.querySelector('.tag.ok')?.textContent?.includes('.ngrr ×30')); assert.ok(refl.querySelector('.tag.warn')?.textContent?.includes('.ncw ×10'));
  assert.ok(q<HTMLElement>('[data-sub="Metronome"]').querySelector('.tag.ok') === null, 'un son .wav n\'est pas un preset');
  click(refl.querySelector('[data-id=sub-use]')!);
  assert.match(sett().presetRoots, /Content\\Reflektor/); assert.match(sett().presetExts, /ngrr/); assert.doesNotMatch(sett().presetExts, /ncw/, 'format à vérifier : jamais ajouté sans accord');
  click(refl.querySelector('[data-id=sub-ext]')!); assert.match(sett().presetExts, /ncw/);
  api.setTestHooks(hooksSnapshot);
});

// ============ presets Blue Cat's (.preset) appliqués automatiquement ============
const realXml = readFileSync('tests/fixtures/bluecat_chaine.carxp', 'utf-8');
const realAxiom = importCarxp(realXml).plugins.find((p) => p.name.includes('Dynamics 4'))!.chunk!.replace(/\s+/g, ''); // état réel de « Dynamics 4 » (preset Full Mix Glue)
const { parseBlueCatState } = await import('../src/lib/vst3state');
const presetFile = 'C:\\Program Files\\Common Files\\VST3\\Blue Cat\'s\\BC Dynamics 4 VST3(Stereo) data\\Factory Presets\\Full Mix Glue [snk].preset';
extra[presetFile] = parseBlueCatState(realAxiom)!.presetXml;

await test('Presets Blue Cat\'s : scan, choix dans le panneau, application AUTOMATIQUE (option cochée) puis écriture dans le .carxp', async () => {
  click(q('[data-tab=presets]'));
  api.setTestHooks({ ...hooksSnapshot, scanPresets: async (_r, _e, onProgress) => { onProgress({ dirs: 100, found: 1, current: 'C:\\x' });
    return { entries: [{ path: presetFile, name: 'Full Mix Glue [snk]', ext: 'preset', kind: 'other', vstId: null, classId: null, hints: ['Factory Presets', 'BC Dynamics 4 VST3(Stereo) data', 'Blue Cat\'s'], size: 99 }], visitedDirs: 120, truncated: false, cancelled: false, unreadable: 0 }; } });
  click(q('[data-id=scan-presets]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.match(q<HTMLElement>('[data-id=presetsummary]').textContent ?? '', /1 fichier\(s\) de presets indexé\(s\).*1 associé/);
  api.setTestHooks(hooksSnapshot);
  // sans l'option : le preset fichier est seulement noté
  const chk = q<HTMLInputElement>('[data-id=auto-bluecat]'); assert.equal(chk.checked, false, 'désactivé par défaut (expérimental)');
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider')); addByPicker("Blue Cat's Dynamics 4(Stereo)"); click(toolbarBtn('+ Entrée carte')); click(toolbarBtn('+ Sortie carte'));
  drag2(port(node('Audio Input'), 'capture_1'), port(node("Blue Cat's Dynamics 4(Stereo)"), 'input_1')); drag2(port(node("Blue Cat's Dynamics 4(Stereo)"), 'output_1'), port(node('Audio Output'), 'playback_1'));
  head2("Blue Cat's Dynamics 4(Stereo)").dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 })); svgEl().dispatchEvent(mouse('mouseup'));
  const pick = q<HTMLSelectElement>('[data-id=presetpick]');
  assert.match(pick.textContent ?? '', /\[fichier\] Full Mix Glue \[snk\]/, '« Factory Presets » est trop générique pour être une famille');
  pick.value = '0'; pick.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await tick(60);
  assert.match(q<HTMLElement>('#status').textContent ?? '', /noté : fichier à charger/);
  assert.doesNotMatch(node("Blue Cat's Dynamics 4(Stereo)").textContent ?? '', /appliqué/);
  click(q('[data-id=save]')); await tick(100);
  assert.notEqual(importCarxp(written['C:\\out\\ma_chaine.carxp']!).plugins[0]!.chunk, realAxiom, 'sans l\'option, pas d\'état écrit');
  // option cochée : conversion et application automatiques
  click(q('[data-tab=presets]')); click(q('[data-id=auto-bluecat]')); assert.equal(JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}').autoApplyBluecat, true);
  click(q('[data-tab=patchbay]'));
  head2("Blue Cat's Dynamics 4(Stereo)").dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 })); svgEl().dispatchEvent(mouse('mouseup'));
  click(q('[data-id=preset-clear]'));
  const pick2 = q<HTMLSelectElement>('[data-id=presetpick]'); pick2.value = '0'; pick2.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await tick(100);
  assert.match(q<HTMLElement>('#status').textContent ?? '', /appliqué automatiquement/);
  assert.match(node("Blue Cat's Dynamics 4(Stereo)").textContent ?? '', /♪ Full Mix Glue \[snk\] \(appliqué\)/);
  click(q('[data-id=save]')); await tick(100);
  assert.equal(importCarxp(written['C:\\out\\ma_chaine.carxp']!).plugins[0]!.chunk, realAxiom, 'état identique à celui que Carla a enregistré');
  click(q('[data-id=auto-bluecat]'));
});

// ============ presets TONE3000 (.t3kpreset) appliqués automatiquement ============
const t3kFile = 'C:\\Users\\Utilisateur\\AppData\\Roaming\\TONE3000\\Presets\\hamide test.t3kpreset';
const t3kBytesUi = new Uint8Array(readFileSync('tests/fixtures/preset_test.t3kpreset'));
await test('TONE3000 : scan du dossier Presets, rattachement au plugin, application AUTOMATIQUE puis écriture dans le .carxp', async () => {
  const { t3kPresetToChunk } = await import('../src/lib/t3k');
  click(q('[data-tab=presets]'));
  api.setTestHooks({ ...hooksSnapshot, readBinaryFile: async (p) => { assert.equal(p, t3kFile); return t3kBytesUi; },
    scanPresets: async () => ({ entries: [{ path: t3kFile, name: 'hamide test', ext: 't3kpreset', kind: 'other', vstId: null, classId: null, hints: ['Presets', 'TONE3000', 'Roaming', 'AppData', 'Admin', 'Users'], size: t3kBytesUi.length }], visitedDirs: 9, truncated: false, cancelled: false, unreadable: 0 }) });
  click(q('[data-id=scan-presets]')); await tick(100);
  assert.match(q<HTMLElement>('[data-id=presetsummary]').textContent ?? '', /1 fichier\(s\) de presets indexé\(s\).*1 associé/);
  const chk = q<HTMLInputElement>('[data-id=auto-bluecat]'); if (!chk.checked) click(chk);
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider')); addByPicker('TONE3000'); click(toolbarBtn('+ Entrée carte')); click(toolbarBtn('+ Sortie carte'));
  drag2(port(node('Audio Input'), 'capture_1'), port(node('TONE3000'), 'input_1')); drag2(port(node('TONE3000'), 'output_1'), port(node('Audio Output'), 'playback_1'));
  head2('TONE3000').dispatchEvent(mouse('mousedown', { clientX: 1, clientY: 1 })); svgEl().dispatchEvent(mouse('mouseup'));
  const pick = q<HTMLSelectElement>('[data-id=presetpick]'); assert.match(pick.textContent ?? '', /\[fichier\] hamide test/);
  pick.value = '0'; pick.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await tick(150);
  assert.match(q<HTMLElement>('#status').textContent ?? '', /appliqué automatiquement/);
  assert.match(node('TONE3000').textContent ?? '', /♪ hamide test \(appliqué\)/);
  click(q('[data-id=save]')); await tick(100);
  const out = importCarxp(written['C:\\out\\ma_chaine.carxp']!).plugins[0]!;
  assert.equal(out.chunk, t3kPresetToChunk(t3kBytesUi).chunk, 'état du preset écrit dans le fichier');
  api.setTestHooks(hooksSnapshot); click(chk);
});

// ============ plugin mono (ReValver) : son des deux côtés ============
await test('bouton « Mono → stéréo » : avertissement quand un seul côté reçoit le son, puis correction (annulable), idempotent', () => {
  click(q('[data-tab=patchbay]')); click(toolbarBtn('Vider')); addByPicker('ReValver'); click(toolbarBtn('+ Entrée carte')); click(toolbarBtn('+ Sortie carte'));
  drag2(port(node('Audio Input'), 'capture_1'), port(node('ReValver'), 'input_1')); drag2(port(node('ReValver'), 'output_1'), port(node('Audio Output'), 'playback_1'));
  assert.equal(qa('svg.editor g.cableg').length, 2);
  assert.match(q<HTMLElement>('#patchbay').textContent ?? '', /« ReValver » n'a qu'une sortie audio \(mono\).*« playback_2 » reste muette/);
  click(q('[data-id=mono-stereo]'));
  assert.equal(qa('svg.editor g.cableg').length, 3); assert.match(q<HTMLElement>('#status').textContent ?? '', /1 câble\(s\) ajouté\(s\)/);
  assert.doesNotMatch(q<HTMLElement>('#patchbay').textContent ?? '', /reste muette/);
  click(q('[data-id=mono-stereo]')); assert.equal(qa('svg.editor g.cableg').length, 3); assert.match(q<HTMLElement>('#status').textContent ?? '', /Rien à corriger/);
  click(q('[data-id=undo]')); assert.equal(qa('svg.editor g.cableg').length, 2, 'annulable');
});

// ============ états tronqués (fichiers produits par une IA) ============
await test('capture d\'un projet dont l\'état est tronqué : refusé avec la raison, rien n\'est ajouté à la bibliothèque', async () => {
  click(q('[data-tab=presets]'));
  extra['C:\\Sons\\biasfx_tronque.carxp'] = readFileSync('tests/fixtures/google_biasfx_tronque.carxp', 'utf-8');
  const avant = qa('[data-state]').length; openPath = 'C:\\Sons\\biasfx_tronque.carxp';
  click(q('[data-id=capture-project]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /aucun état de plugin utilisable.*Refusé : « BIAS FX 2 » \(état tronqué : 463118 octets annoncés, 1301 présents\)/);
  assert.equal(qa('[data-state]').length, avant, 'rien d\'ajouté'); openPath = null;
});

// ============ plugins : ajout à la main, fusion de la base, rôles ; recettes sans IA ============
const bundleDb = (name: string, path: string) => ({ type: 'VST3', name, label: name, maker: '', path, uniqueId: null, category: '', isSynth: false, audioIns: 2, audioOuts: 2, midiIns: 0, midiOuts: 0 });
await test('Plugins : un scan AJOUTE à la base (rien n\'est effacé) ; l\'option « remplacer » existe ; « Vider » demande confirmation', async () => {
  click(q('[data-tab=plugins]'));
  const avant = qa('#plugins tbody tr').length; const total = () => Number(/(\d+) plugin\(s\) dans la base/.exec(q<HTMLElement>('[data-id=dbsummary]').textContent ?? '')?.[1]);
  const n0 = total();
  const vus: Array<[string[], string[]]> = [];
  api.setTestHooks({ ...hooksSnapshot, scanPlugins: async (_d, v3, v2) => { vus.push([v3, v2]); return { plugins: [bundleDb('TONE3000', 'C:\\Program Files\\Common Files\\VST3\\TONE3000.vst3\\Contents\\x86_64-win\\TONE3000.vst3'), bundleDb('Nouveau Plugin', 'C:\\VST3\\Nouveau.vst3')], errors: [{ kind: 'VST3', path: 'C:\\VST3\\casse.vst3', reason: 'pas un plugin' }], totalFiles: 3 }; } });
  set(q<HTMLInputElement>('#plugins input'), 'C:\\Carla\\carla-discovery-native.exe');
  click(q('[data-id=scan]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  assert.equal(total(), n0 + 1, 'seul « Nouveau Plugin » est nouveau (TONE3000 existait déjà au même nom mais autre chemin : ajouté aussi ?)'.length > 0 ? total() : 0);
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Base : \d+ plugin\(s\) \(\d+ ajouté\(s\), \d+ mis à jour, \d+ déjà présents conservés\)/);
  assert.ok(total() >= n0 + 1 && total() >= avant, 'la base n\'a pas rétréci');
  // option « remplacer » : la base ne contient plus que ce que le scan a trouvé
  click(q('[data-id=merge-scan]')); click(q('[data-id=scan]')); await tick(100);
  assert.equal(total(), 2); assert.match(q<HTMLElement>('#status').textContent ?? '', /La base a été remplacée/);
  click(q('[data-id=merge-scan]'));
  // vider : deux clics
  click(q('[data-id=clear-db]')); assert.equal(total(), 2, 'premier clic : rien ne se passe'); assert.match(q<HTMLElement>('[data-id=clear-db]').textContent ?? '', /Confirmer/);
  click(q('[data-id=clear-db]')); assert.equal(total(), 0);
  api.setTestHooks(hooksSnapshot);
});
await test('Plugins : ajouter un dossier VST3/VST2, un plugin précis (.vst3 ou .dll) et les emplacements habituels', async () => {
  const sett = () => JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}');
  let next: string | null = null;
  api.setTestHooks({ ...hooksSnapshot, pickFolder: async () => next, pickOpen: async () => next });
  next = 'D:\\Mes plugins\\Sous dossier'; click(q('[data-id=add-dir3]')); await tick(60);
  assert.match(sett().vst3, /D:\\Mes plugins\\Sous dossier/); assert.match(q<HTMLTextAreaElement>('#plugins textarea').value, /Sous dossier/);
  next = 'E:\\Anciens\\VST2'; click(q('[data-id=add-dir2]')); await tick(60); assert.match(sett().vst2, /E:\\Anciens\\VST2/);
  next = 'C:\\Program Files\\Common Files\\VST3\\TONE3000.vst3\\Contents\\x86_64-win\\TONE3000.vst3'; click(q('[data-id=add-file]')); await tick(60); assert.match(sett().vst3, /TONE3000\.vst3/);
  next = 'D:\\Vieux\\Plugin.dll'; click(q('[data-id=add-file]')); await tick(60); assert.match(sett().vst2, /Plugin\.dll/); assert.doesNotMatch(sett().vst3, /Plugin\.dll/);
  click(q('[data-id=add-dir3]')); await tick(60); click(q('[data-id=add-dir3]')); await tick(60);
  assert.equal((sett().vst3.match(/Sous dossier/g) ?? []).length, 1, 'pas de doublon');
  next = null; click(q('[data-id=add-dir3]')); await tick(60);                   // annulation du sélecteur : rien ne change
  click(q('[data-id=usual-dirs]')); assert.match(sett().vst3, /Common Files\\VST3/); assert.match(sett().vst2, /VstPlugins/);
  api.setTestHooks(hooksSnapshot);
});
await test('Recettes : base vide → message clair ; base remplie → chaîne construite SANS IA, câblée, avec le rapport des étapes', async () => {
  click(q('[data-tab=assistant]'));
  click(q('[data-id=build-recipe]')); await tick(60);
  assert.equal(q<HTMLElement>('#status').className, 'err'); assert.match(q<HTMLElement>('#status').textContent ?? '', /Aucun plugin utilisable/);
  assert.match(q<HTMLElement>('[data-id=roleinfo]').textContent ?? '', /Base très petite/);
  // on remplit la base (scan simulé), puis on construit
  click(q('[data-tab=plugins]'));
  api.setTestHooks({ ...hooksSnapshot, scanPlugins: async () => ({ plugins: [bundleDb('MCompressor', 'C:\\V\\MCompressor.vst3'), bundleDb('Fender Twin Reverb 65', 'C:\\V\\Twin.vst3'), bundleDb('MEqualizer', 'C:\\V\\MEq.vst3'), bundleDb('Spring Reverb', 'C:\\V\\Spring.vst3'),
    bundleDb('Roland JC-120 Jazz Chorus', 'C:\\V\\JC.vst3'), bundleDb('MDelay', 'C:\\V\\MDelay.vst3'), bundleDb('LoopRecorder', 'C:\\V\\Loop.vst3')], errors: [], totalFiles: 7 }) });
  click(q('[data-id=scan]')); await tick(100); api.setTestHooks(hooksSnapshot);
  click(q('[data-tab=assistant]'));
  assert.match(q<HTMLElement>('[data-id=roleinfo]').textContent ?? '', /Votre base : 7 plugin\(s\).*Ampli 2.*Compresseur 1/);
  const sel = q<HTMLSelectElement>('[data-id=recipe]'); sel.value = 'jazz-benson'; sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.match(q<HTMLElement>('[data-id=recipe-desc]').textContent ?? '', /Vintage Guitar/);
  const gi = q<HTMLSelectElement>('[data-id=guitar-input]'); assert.ok([...gi.options].length >= 1);
  const chk = q<HTMLInputElement>('[data-id=modify]'); chk.checked = false;
  click(q('[data-id=build-recipe]')); await tick(100);
  assert.equal(q<HTMLElement>('#status').className, 'ok', q<HTMLElement>('#status').textContent ?? '');
  const res = q<HTMLElement>('[data-id=recipe-result]').textContent ?? '';
  assert.match(res, /Compresseur \(facultatif\) : MCompressor/); assert.match(res, /Ampli : (Fender Twin Reverb 65|Roland JC-120 Jazz Chorus)/); assert.match(res, /Égaliseur \(facultatif\) : MEqualizer/); assert.match(res, /Réverbération \(facultatif\) : Spring Reverb/);
  assert.match(res, /Conseils de jeu/);
  click(q('[data-tab=patchbay]')); assert.equal(qa('svg.editor g.node').length, 6); assert.equal(qa('svg.editor g.cableg').length >= 8, true);
  assert.doesNotMatch(q<HTMLElement>('#patchbay').textContent ?? '', /n'est pas reliée/);
  click(q('[data-id=undo]')); // annulable
});
await test('Plugins : le rôle est reconnu d\'après le nom (affiché), corrigeable à la main (mémorisé), et le total par rôle s\'adapte', () => {
  click(q('[data-tab=plugins]'));
  const row = (nom: string) => [...qa('#plugins tbody tr')].find((tr) => tr.querySelector('td')?.textContent === nom)!;
  const sel = (nom: string) => row(nom).querySelector<HTMLSelectElement>('[data-id=role]')!;
  assert.match(sel('MDelay').options[0]!.textContent ?? '', /\(auto\) Delay \/ écho/); assert.match(sel('Fender Twin Reverb 65').options[0]!.textContent ?? '', /\(auto\) Ampli/);
  assert.match(sel('LoopRecorder').options[0]!.textContent ?? '', /Outil/);
  const sett = () => JSON.parse(dom.window.localStorage.getItem('carlaWiring.settings') ?? '{}');
  const countsReverb = () => /Réverbération (\d+)/.exec(q<HTMLElement>('[data-id=roleinfo]').textContent ?? '')?.[1];
  assert.equal(countsReverb(), '1');
  const md = sel('MDelay'); md.value = 'reverb'; md.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(sett().roleOverrides['C:\\V\\MDelay.vst3|MDelay'], 'reverb'); assert.equal(countsReverb(), '2', 'le plugin corrigé compte comme réverbération');
  const nbLignes = qa('#plugins tbody tr').length; row('MDelay').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(qa('svg.editor g.node').length >= 1, 'un clic sur la ligne ajoute le plugin au Patchbay'); void nbLignes;
  const before = qa('svg.editor g.node').length; sel('MDelay').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(qa('svg.editor g.node').length, before, 'un clic sur la liste des rôles n\'ajoute rien au Patchbay');
  md.value = ''; md.dispatchEvent(new dom.window.Event('change', { bubbles: true })); assert.equal(sett().roleOverrides['C:\\V\\MDelay.vst3|MDelay'], undefined); assert.equal(countsReverb(), '1');
});
await test('Recettes : l\'assistant IA qui échoue propose la recette la plus proche de la demande (et la sélectionne)', async () => {
  click(q('[data-tab=assistant]'));
  const prov = q<HTMLSelectElement>('[data-id=provider]'); prov.value = 'anthropic'; prov.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  set(q<HTMLInputElement>('[data-id=apikey]'), 'cle-test');
  const bk = q<HTMLSelectElement>('[data-id=backup]'); bk.value = ''; bk.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  api.setTestHooks(hooksSnapshot); api.setAiTransport(async () => '{"nodes":[{"id":"n1","plugin":"p9"}],"cables":[]}');
  set(q<HTMLTextAreaElement>('[data-id=request]'), 'le son reggae de Bob Marley');
  click(q('[data-id=create]')); await tick(200);
  assert.equal(q<HTMLElement>('#status').className, 'err');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /\(de p1 à p7\)/, 'les identifiants valides sont indiqués à l\'IA et à l\'utilisateur');
  assert.match(q<HTMLElement>('#status').textContent ?? '', /Astuce : la carte « Recettes de sons » .*\(« Reggae — rythmique générale » est déjà choisie pour vous\)/);
  assert.equal(q<HTMLSelectElement>('[data-id=recipe]').value, 'reggae');
  assert.match(q<HTMLElement>('[data-id=log]').textContent ?? '', /Attention : votre base ne contient que|Essai 3/);
});
console.log(`\n${ok} tests réussis`);
process.exit(0);
