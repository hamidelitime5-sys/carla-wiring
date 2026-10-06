// src/lib/sheet.ts : fiche de la chaîne (Markdown), à garder sous la main pour le concert.
import { connectionsOf, type PatchProject } from './carxp';

export function chainSheet(project: PatchProject, title?: string): string {
  const meta = project.meta;
  const plugins = project.nodes.filter((n) => n.kind === 'plugin' && n.plugin).sort((a, b) => a.x - b.x || a.y - b.y);
  const L: string[] = [];
  L.push(`# ${title || meta?.name || 'Chaîne Carla'}`, '');
  if (meta?.summary) L.push(meta.summary, '');
  L.push('## Chemin du signal', '');
  if (!plugins.length) L.push('_Aucun plugin._');
  plugins.forEach((n, i) => {
    const p = n.plugin;
    L.push(`${i + 1}. **${n.name}**${n.bypass ? ' _(contourné)_' : ''} — ${p?.type ?? ''}${p?.isSynth ? ', instrument' : ''}, ${p?.audioIns ?? 0} entrée(s) / ${p?.audioOuts ?? 0} sortie(s) audio${p && p.midiIns > 0 ? ', MIDI' : ''}${n.preset ? `\n   - Preset : ${n.preset.name}${n.preset.collection ? ` — ${n.preset.collection}` : ''}${n.preset.applied ? ' (fichier .preset converti : appliqué dans le projet)' : n.preset.kind === 'file' && n.preset.path ? ` (fichier à charger dans le plugin : ${n.preset.path})` : n.preset.kind === 'state' ? ' (son capturé : appliqué dans le projet)' : ''}` : ''}`);
  });
  L.push('', '## Câblage', '');
  const conns = connectionsOf(project);
  if (!conns.length) L.push('_Aucun câble._');
  for (const [s, t] of conns) L.push(`- \`${s}\` → \`${t}\``);
  if (meta?.notes.length) { L.push('', '## Conseils pour le live', ''); for (const n of meta.notes) L.push(`- ${n}`); }
  if (meta?.missing.length) { L.push('', '## Ce qui manquait dans la base', ''); for (const n of meta.missing) L.push(`- ${n}`); }
  const files = plugins.map((n) => n.plugin?.path).filter((x): x is string => !!x);
  if (files.length) { L.push('', '## Fichiers des plugins', ''); for (const f of files) L.push(`- ${f}`); }
  L.push('');
  return L.join('\n');
}
