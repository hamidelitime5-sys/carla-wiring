// Test : npx tsx tests/migrate.test.ts : une ancienne version (une seule clé) devient la clé du fournisseur courant.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' });
const W = dom.window as unknown as Record<string, unknown>;
for (const k of ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'])
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : W[k], configurable: true, writable: true });
dom.window.localStorage.setItem('carlaWiring.settings', JSON.stringify({ provider: 'gemini', apiKey: 'ancienne-cle', model: 'gemini-perso', request: 'ma demande' }));
await import('../src/main');
const q = <T extends Element>(s: string): T => { const e = dom.window.document.querySelector<T>(s); assert.ok(e, s); return e as T; };
assert.equal(q<HTMLSelectElement>('[data-id=provider]').value, 'gemini');
assert.equal(q<HTMLInputElement>('[data-id=apikey]').value, 'ancienne-cle');
assert.equal(q<HTMLInputElement>('[data-id=model]').value, 'gemini-perso');
assert.equal(q<HTMLTextAreaElement>('[data-id=request]').value, 'ma demande');
q<HTMLSelectElement>('[data-id=provider]').value = 'anthropic';
q<HTMLSelectElement>('[data-id=provider]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
assert.equal(q<HTMLInputElement>('[data-id=apikey]').value, '', 'les autres fournisseurs n\'héritent pas de la clé');
assert.equal(q<HTMLInputElement>('[data-id=model]').value, 'claude-sonnet-4-6');
console.log('  OK  migration d\'une ancienne configuration (1 clé, 1 modèle)\n\n1 test réussi');
process.exit(0);
