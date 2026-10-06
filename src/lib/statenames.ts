// src/lib/statenames.ts : lire, dans l'état d'un plugin enregistré par Carla, le NOM du preset qui était chargé.
// Familles vérifiées sur de vrais projets :
//   Blue Cat's  : document XML <Preset progName="…" currentPresetFilePath="…">
//   BIAS FX 2   : JSON lisible, clé "currentPresetName"
//   MeldaProduction : état compressé (zlib), clé « CurrentPresetID » de la forme « Catégorie~Nom »
//   TONE3000    : arbre binaire « T3KB » ; chaque bloc (ChainBlock) contient le JSON complet de la capture du catalogue (titre, appareil, tags)
//   ReValver 5  : bloc binaire opaque, aucun nom lisible → nom non disponible
import { zlibInflate } from './inflate';
import { parseBlueCatState, unwrapVc2 } from './vst3state';

export interface StateInfo {
  family: 'bluecat' | 'bias' | 'melda' | 'tone3000' | 'unknown';
  name?: string; // nom du preset
  collection?: string; // dossier / catégorie d'origine
  keywords?: string[]; // mots utiles à la recherche (tags, fabricants), non affichés
}

const utf8 = new TextDecoder('utf-8');

/** Objets JSON (accolades équilibrées, chaînes et échappements respectés) qui suivent chaque occurrence de `marker`. */
function jsonAfter(text: string, marker: string): unknown[] {
  const out: unknown[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(marker, from);
    if (i < 0) break;
    const s = text.indexOf('{', i);
    if (s < 0) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let k = s; k < text.length; k++) {
      const ch = text[k];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    if (end < 0) break;
    try { out.push(JSON.parse(text.slice(s, end))); } catch { /* bloc illisible : ignoré */ }
    from = end;
  }
  return out;
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function describeTone3000(comp: Uint8Array): StateInfo {
  const text = utf8.decode(comp);
  const tones = jsonAfter(text, 'toneJson').filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null);
  const titles = tones.map((t) => (typeof t.title === 'string' ? t.title : '')).filter((t) => t);
  const preset = /activePresetName\u0000[^\u0020-\u007e]*([\u0020-\u007e]{2,160})/.exec(text)?.[1]?.trim();
  const base = preset || titles[0];
  const others = titles.slice(1).map((t) => short(t, 40));
  const name = base ? (others.length ? `${short(base, 60)} + ${others.slice(0, 3).join(' + ')}${others.length > 3 ? ' …' : ''}` : short(base, 90)) : undefined;
  const gears = [...new Set(tones.map((t) => (typeof t.gear === 'string' ? t.gear : '')).filter((g) => g))];
  const kw = new Set<string>();
  for (const t of tones) {
    for (const list of [t.tags, t.makes]) if (Array.isArray(list)) for (const x of list) { const n = (x as { name?: unknown })?.name; if (typeof n === 'string' && n.length >= 3) kw.add(n.toLowerCase()); }
  }
  return { family: 'tone3000', ...(name ? { name } : {}), ...(gears.length ? { collection: gears.join(' + ') } : {}), ...(kw.size ? { keywords: [...kw].slice(0, 40) } : {}) };
}

export function describeState(chunkB64: string): StateInfo {
  const bc = parseBlueCatState(chunkB64);
  if (bc) return { family: 'bluecat', ...(bc.progName ? { name: bc.progName } : {}), ...(bc.presetPath?.split('/').slice(-2, -1)[0] ? { collection: bc.presetPath.split('/').slice(-2, -1)[0] } : {}) };
  const comp = unwrapVc2(chunkB64);
  if (!comp || comp.length < 8) return { family: 'unknown' };
  try {
    if (utf8.decode(comp.subarray(0, 4)) === 'T3KB') return describeTone3000(comp);
    if (utf8.decode(comp.subarray(0, 4)) === 'VstW') {
      const m = /"currentPresetName"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(utf8.decode(comp));
      if (m && m[1]) { let name = m[1]; try { name = JSON.parse(`"${m[1]}"`) as string; } catch { /* nom gardé tel quel */ } return { family: 'bias', name }; }
      return { family: 'unknown' };
    }
    if (comp[0] === 0x78) {
      const text = utf8.decode(zlibInflate(comp));
      const m = /CurrentPresetID\u0000s([^\u0000]*)\u0000/.exec(text);
      if (m && m[1]) {
        const [a, ...rest] = m[1].split('~');
        return rest.length ? { family: 'melda', name: rest.join('~'), collection: a } : { family: 'melda', name: m[1] };
      }
      return { family: 'melda' };
    }
  } catch {
    /* format inattendu : on ne présume de rien */
  }
  return { family: 'unknown' };
}
