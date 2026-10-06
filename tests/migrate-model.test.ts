// Test : npx tsx tests/migrate-model.test.ts : l'ancien modèle Gemini par défaut (404 chez Google) est remplacé.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' });
const W = dom.window as unknown as Record<string, unknown>;
for (const k of ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'])
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : W[k], configurable: true, writable: true });
dom.window.localStorage.setItem('carlaWiring.settings', JSON.stringify({ provider: 'gemini', apiKeys: { gemini: 'ma-cle' }, models: { gemini: 'gemini-2.5-flash', anthropic: 'claude-perso' } }));
await import('../src/main');
const q = <T extends Element>(s: string): T => { const e = dom.window.document.querySelector<T>(s); assert.ok(e, s); return e as T; };
assert.equal(q<HTMLInputElement>('[data-id=model]').value, 'gemini-3.8-flash', 'ancien défaut remplacé');
assert.equal(q<HTMLInputElement>('[data-id=apikey]').value, 'ma-cle', 'la clé est conservée');
q<HTMLSelectElement>('[data-id=provider]').value = 'anthropic';
q<HTMLSelectElement>('[data-id=provider]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
assert.equal(q<HTMLInputElement>('[data-id=model]').value, 'claude-perso', 'un modèle choisi à la main n\'est pas touché');
console.log('  OK  ancien modèle Gemini remplacé, clé et autres modèles conservés\n\n1 test réussi');
process.exit(0);
