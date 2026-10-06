// src/lib/matrix.ts
// Génération du câblage d'un plugin multi-sorties (jusqu'à 32 sorties audio) + MIDI.
// Universel : le nom du plugin source et ses nombres de ports sont des VARIABLES reçues de l'interface
// (liste scannée, fichier .carxp ouvert, ou session Carla active) ; rien n'est figé sur un instrument.
import { connectionsOf, type DbPlugin, type PatchCable, type PatchNode, type PatchProject } from './carxp';

export const MAX_OUTPUTS = 32;

export type WiringMode = 'fold-stereo' | 'one-to-one' | 'to-mixer';

export interface PluginRef {
  name: string;
  audioIns: number;
  audioOuts: number;
  midiIns: number;
  midiOuts: number;
}

export interface WiringSpec {
  hardware: { audioOut: string[]; midiPort: string };
  source: PluginRef;
  mode: WiringMode;
  count: number; // nombre de sorties du plugin source à câbler (1..32)
  mixer?: PluginRef; // mode 'to-mixer' : table de mixage / plugin récepteur
  midi: { enabled: boolean };
}

export interface WiringResult {
  project: PatchProject;
  connections: Array<[string, string]>;
  warnings: string[];
  wired: number;
}

export function parseNames(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function toStub(ref: PluginRef, db?: DbPlugin): DbPlugin {
  const base: DbPlugin = db ?? {
    type: 'VST2', name: ref.name, label: ref.name, maker: '', path: '', uniqueId: null,
    category: '', isSynth: false, audioIns: 0, audioOuts: 0, midiIns: 0, midiOuts: 0,
  };
  return { ...base, audioIns: ref.audioIns, audioOuts: ref.audioOuts, midiIns: ref.midiIns, midiOuts: ref.midiOuts };
}

function node(id: string, kind: PatchNode['kind'], name: string, plugin?: DbPlugin): PatchNode {
  return { id, kind, name, plugin, x: 0, y: 0 };
}

export function buildWiring(spec: WiringSpec, sourceDb?: DbPlugin, mixerDb?: DbPlugin): WiringResult {
  const warnings: string[] = [];
  const hwOut = spec.hardware.audioOut;
  const src = spec.source;
  const requested = Math.max(1, Math.floor(spec.count) || 1);
  if (requested > MAX_OUTPUTS) warnings.push(`Maximum ${MAX_OUTPUTS} sorties : ${requested} demandées, ${MAX_OUTPUTS} câblées.`);
  let n = Math.min(requested, MAX_OUTPUTS);
  if (src.audioOuts <= 0) {
    warnings.push(`« ${src.name} » n'a aucune sortie audio : rien à câbler.`);
    n = 0;
  } else if (n > src.audioOuts) {
    warnings.push(`« ${src.name} » n'a que ${src.audioOuts} sortie(s) audio : ${n} demandées.`);
    n = src.audioOuts;
  }

  const nodes: PatchNode[] = [node('src', 'plugin', src.name, toStub(src, sourceDb))];
  const cables: PatchCable[] = [];
  const cable = (fromNode: string, fromPort: string, toNode: string, toPort: string) =>
    cables.push({ fromNode, fromPort, toNode, toPort });

  if (hwOut.length === 0) warnings.push('Aucune sortie matérielle définie dans le profil de la carte son.');
  if (hwOut.length > 0) nodes.push(node('hwout', 'hw-out', 'Audio Output'));
  let wired = 0;

  if (spec.mode === 'fold-stereo' && hwOut.length > 0) {
    const sides = Math.min(2, hwOut.length);
    for (let i = 1; i <= n; i++) {
      cable('src', `output_${i}`, 'hwout', hwOut[(i - 1) % sides] ?? '');
      wired++;
    }
  } else if (spec.mode === 'one-to-one' && hwOut.length > 0) {
    for (let i = 1; i <= n; i++) {
      const target = hwOut[i - 1];
      if (target === undefined) {
        warnings.push(`La carte n'a que ${hwOut.length} sortie(s) : les sorties ${i} à ${n} du plugin ne sont pas câblées.`);
        break;
      }
      cable('src', `output_${i}`, 'hwout', target);
      wired++;
    }
  } else if (spec.mode === 'to-mixer') {
    const mixer = spec.mixer;
    if (!mixer || !mixer.name.trim()) {
      warnings.push('Mode « vers un mixeur » : indiquez le nom du plugin mixeur.');
    } else if (mixer.name === src.name) {
      warnings.push('Le mixeur et la source portent le même nom : Carla exige des noms uniques.');
    } else {
      nodes.push(node('mixer', 'plugin', mixer.name, toStub(mixer, mixerDb)));
      for (let i = 1; i <= n; i++) {
        if (i > mixer.audioIns) {
          warnings.push(`« ${mixer.name} » n'a que ${mixer.audioIns} entrée(s) audio : les sorties ${i} à ${n} ne sont pas câblées.`);
          break;
        }
        cable('src', `output_${i}`, 'mixer', `input_${i}`);
        wired++;
      }
      // sorties du mixeur vers la carte (paires stéréo 1-2)
      if (hwOut.length > 0 && mixer.audioOuts > 0) {
        const sides = Math.min(2, hwOut.length, mixer.audioOuts);
        for (let k = 1; k <= sides; k++) cable('mixer', `output_${k}`, 'hwout', hwOut[k - 1] ?? '');
      } else if (mixer.audioOuts <= 0) {
        warnings.push(`« ${mixer.name} » n'a pas de sortie audio : ses sorties ne sont pas reliées à la carte.`);
      }
    }
  }

  // MIDI : port MIDI matériel vers l'entrée d'événements du plugin source
  if (spec.midi.enabled) {
    const port = spec.hardware.midiPort.trim();
    if (!port) {
      warnings.push('Port MIDI matériel non indiqué.');
    } else if (src.midiIns <= 0) {
      warnings.push(`« ${src.name} » n'a pas d'entrée MIDI (events-in) : MIDI non câblé.`);
    } else {
      nodes.push(node('midi', 'midi-in', 'Midi Input'));
      cable('midi', port, 'src', 'events-in');
    }
  }

  const project: PatchProject = {
    nodes,
    cables,
    hardware: { name: 'profil', audioIn: [], audioOut: hwOut, midiIn: spec.midi.enabled && spec.hardware.midiPort.trim() ? [spec.hardware.midiPort.trim()] : [] },
  };
  return { project, connections: connectionsOf(project), warnings, wired };
}
