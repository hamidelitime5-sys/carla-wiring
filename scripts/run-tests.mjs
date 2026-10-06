// Lance tous les tests (tests/*.test.ts). Un test qui a besoin d'un fichier de test PRIVÉ absent (dossier tests/fixtures,
// jamais publié) est « ignoré » et non « en échec » : le dépôt public reste vérifiable par tout le monde.
// Utilisation : npm test
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).sort();
const results = { ok: [], skipped: [], failed: [] };
let total = 0;
for (const f of files) {
  const r = spawnSync('npx', ['tsx', `tests/${f}`], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status === 0) {
    const n = Number(/(\d+) tests? réussis?/.exec(out)?.[1] ?? 0);
    total += n; results.ok.push([f, n]);
    console.log(`  ok       ${f} (${n} tests)`);
  } else if (/ENOENT[^\n]*tests[\\/]+fixtures/.test(out)) {
    results.skipped.push(f);
    console.log(`  ignoré   ${f} (fichiers de test privés absents : voir tests/FIXTURES.md)`);
  } else {
    results.failed.push(f);
    console.log(`  ÉCHEC    ${f}\n${out.split('\n').slice(-25).join('\n')}`);
  }
}
console.log(`\n${results.ok.length} fichier(s) réussi(s) (${total} tests), ${results.skipped.length} ignoré(s), ${results.failed.length} en échec.`);
process.exit(results.failed.length ? 1 : 0);
