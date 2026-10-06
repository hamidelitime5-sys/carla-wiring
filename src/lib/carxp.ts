// src/lib/carxp.ts
// Export / import / validation des projets Carla (.carxp) pour l'appli Patchbay.
// Aucune dépendance. Fonctionne dans le navigateur et dans Node.
//
// Format vérifié sur un vrai projet Carla 2.5 (bluecat_basse.carxp) :
//   <CARLA-PROJECT VERSION='2.5'> EngineSettings, Transport, [<Plugin>...], <Patchbay>
//   Plugin : <Info> Type, Name, Binary, (UniqueID pour VST2 | Label pour VST3) ; <Data> Active, ControlChannel, Options, [Chunk]
//   Câble  : <Connection><Source>Groupe:port</Source><Target>Groupe:port</Target></Connection>
//   Ports plugin : input_1.., output_1.., events-in, events-out
//   Groupes matériel : "Audio Input", "Audio Output", "Midi Input"  (les noms de ports dépendent du pilote)

// ------------------------------------------------------------------------------------------------
// Types

export interface DbPlugin {
  type: string; // 'VST2' | 'VST3' | 'JSFX' ...
  name: string;
  label: string;
  maker: string;
  path: string; // chemin complet (Binary)
  uniqueId: number | null; // VST2
  category: string;
  isSynth: boolean;
  audioIns: number;
  audioOuts: number;
  midiIns: number;
  midiOuts: number;
}

export interface HardwareProfile {
  name: string;
  audioIn: string[]; // noms de ports tels que Carla les affiche (ex. "Left", "Right" ou noms ASIO)
  audioOut: string[];
  midiIn: string[]; // ex. "Capture 1"
}

export type NodeKind = 'hw-in' | 'hw-out' | 'midi-in' | 'plugin';

/** Preset associé à un plugin : un fichier (à charger dans le plugin) ou un « son capturé » (état injecté dans le .carxp). */
export interface PresetRef {
  kind: 'file' | 'state';
  name: string;
  path?: string;
  stateId?: string;
  collection?: string; // composant ou famille d'où vient le preset (ex. « Reflektor », « Rack Presets »)
  applied?: boolean; // fichier de preset converti et écrit dans l'état du plugin (Blue Cat's)
}

export interface PatchNode {
  id: string;
  kind: NodeKind;
  name: string; // pour un plugin : doit être unique (c'est le nom Carla)
  plugin?: DbPlugin;
  bypass?: boolean;
  chunk?: string; // état sauvegardé (base64) repris d'un .carxp existant
  raw?: string; // bloc <Plugin> d'origine d'un projet ouvert : réécrit tel quel (réglages conservés), seul <Active> est ajusté
  program?: { index: number; name: string }; // <CurrentProgramIndex> / <CurrentProgramName> écrits par Carla pour les plugins qui exposent des programmes (ex. Melda)
  color?: string; // couleur choisie dans le Patchbay (propre à cet outil : Carla ne la conserve pas)
  preset?: PresetRef; // preset associé à ce plugin
  x: number;
  y: number;
}

export interface PatchCable {
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface EngineSettings {
  forceStereo: boolean;
  preferPluginBridges: boolean;
  preferUiBridges: boolean;
  uisAlwaysOnTop: boolean;
  maxParameters: number;
  uiBridgesTimeout: number;
}

/** Ce qui entoure les plugins et le câblage dans un projet ouvert : conservé tel quel à l'enregistrement. */
export interface ProjectBase {
  head: string; // tout ce qui précède le premier plugin (EngineSettings, Transport…)
  tail: string; // tout ce qui suit le câblage (ExternalPatchbay…)
  hwPositions: string; // positions des groupes matériel (Audio Input, Audio Output, Midi Input)
}

/** Description lisible d'une chaîne (fournie par l'assistant IA), pour la fiche de concert. */
export interface ProjectMeta {
  name: string;
  summary: string;
  notes: string[];
  missing: string[];
}

/** Variante d'un même rig pour le live : quels plugins sont contournés, et quel câblage est actif. */
export interface Scene {
  id: string;
  name: string;
  bypass: string[]; // identifiants des plugins contournés
  cables: PatchCable[];
}

export interface PatchProject {
  nodes: PatchNode[];
  cables: PatchCable[];
  hardware: HardwareProfile;
  engine?: Partial<EngineSettings>;
  bpm?: number;
  base?: ProjectBase;
  meta?: ProjectMeta;
  scenes?: Scene[];
}

export interface PortInfo {
  name: string;
  type: 'audio' | 'midi';
}

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export const DEFAULT_ENGINE: EngineSettings = {
  forceStereo: false,
  preferPluginBridges: false,
  preferUiBridges: true,
  uisAlwaysOnTop: false,
  maxParameters: 200,
  uiBridgesTimeout: 4000,
};

export const GROUP_AUDIO_IN = 'Audio Input';
export const GROUP_AUDIO_OUT = 'Audio Output';
export const GROUP_MIDI_IN = 'Midi Input';

// ------------------------------------------------------------------------------------------------
// Ports d'un nœud

export function nodePorts(node: PatchNode, hw: HardwareProfile): { inputs: PortInfo[]; outputs: PortInfo[] } {
  const inputs: PortInfo[] = [];
  const outputs: PortInfo[] = [];
  if (node.kind === 'hw-in') {
    hw.audioIn.forEach((n) => outputs.push({ name: n, type: 'audio' }));
  } else if (node.kind === 'hw-out') {
    hw.audioOut.forEach((n) => inputs.push({ name: n, type: 'audio' }));
  } else if (node.kind === 'midi-in') {
    hw.midiIn.forEach((n) => outputs.push({ name: n, type: 'midi' }));
  } else if (node.plugin) {
    for (let i = 1; i <= node.plugin.audioIns; i++) inputs.push({ name: `input_${i}`, type: 'audio' });
    if (node.plugin.midiIns > 0) inputs.push({ name: 'events-in', type: 'midi' });
    for (let i = 1; i <= node.plugin.audioOuts; i++) outputs.push({ name: `output_${i}`, type: 'audio' });
    if (node.plugin.midiOuts > 0) outputs.push({ name: 'events-out', type: 'midi' });
  }
  return { inputs, outputs };
}

/** Nom du groupe tel qu'il apparaît dans les <Source>/<Target> */
export function groupName(node: PatchNode): string {
  if (node.kind === 'hw-in') return GROUP_AUDIO_IN;
  if (node.kind === 'hw-out') return GROUP_AUDIO_OUT;
  if (node.kind === 'midi-in') return GROUP_MIDI_IN;
  return node.name;
}

// ------------------------------------------------------------------------------------------------
// Validation

/**
 * @param opts.requirePluginFiles true (défaut) : chaque plugin doit avoir chemin + identifiant (export d'un nouveau projet).
 *        false : on ne vérifie que les noms et les ports (réécriture du câblage d'un .carxp existant).
 */
export function validateProject(project: PatchProject, opts: { requirePluginFiles?: boolean } = {}): Issue[] {
  const requireFiles = opts.requirePluginFiles !== false;
  const issues: Issue[] = [];
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const hw = project.hardware;

  // noms de plugins uniques
  const seen = new Map<string, string>();
  for (const n of project.nodes.filter((x) => x.kind === 'plugin')) {
    const key = n.name.toLowerCase();
    if (!n.name.trim()) issues.push({ level: 'error', message: 'Un plugin n\'a pas de nom.', nodeId: n.id });
    if (seen.has(key)) {
      issues.push({ level: 'error', message: `Deux plugins portent le nom « ${n.name} » : Carla exige des noms uniques.`, nodeId: n.id });
    }
    seen.set(key, n.id);
    if (!n.plugin) {
      issues.push({ level: 'error', message: `« ${n.name} » n'est pas dans la base de plugins : export impossible.`, nodeId: n.id });
      continue;
    }
    if (!requireFiles) continue;
    if (n.raw) continue; // plugin d'un projet ouvert : ses références viennent du fichier
    if (!n.plugin.path) issues.push({ level: 'error', message: `« ${n.name} » n'a pas de chemin de fichier.`, nodeId: n.id });
    if (n.plugin.type === 'VST2' && !n.plugin.uniqueId) {
      issues.push({ level: 'error', message: `« ${n.name} » (VST2) n'a pas d'identifiant (UniqueID) : relancez le scan.`, nodeId: n.id });
    }
    if (n.plugin.type === 'VST3' && !n.plugin.label) {
      issues.push({ level: 'error', message: `« ${n.name} » (VST3) n'a pas de label : relancez le scan.`, nodeId: n.id });
    }
    if (n.plugin.type === 'JSFX') {
      issues.push({ level: 'warning', message: `« ${n.name} » est un JSFX : le format exact dans le .carxp n'est pas vérifié, testez l'ouverture dans Carla.`, nodeId: n.id });
    }
  }

  // câbles
  const cableKeys = new Set<string>();
  const connectedIn = new Set<string>(); // "nodeId|port"
  const connectedNodes = new Set<string>();
  for (const c of project.cables) {
    const a = byId.get(c.fromNode);
    const b = byId.get(c.toNode);
    if (!a || !b) {
      issues.push({ level: 'error', message: 'Un câble pointe vers un nœud qui n\'existe pas.' });
      continue;
    }
    const pa = nodePorts(a, hw).outputs.find((p) => p.name === c.fromPort);
    const pb = nodePorts(b, hw).inputs.find((p) => p.name === c.toPort);
    if (!pa) {
      issues.push({ level: 'error', message: `Le port de sortie « ${c.fromPort} » n'existe pas sur « ${a.name} » (ou c'est une entrée).`, nodeId: a.id });
      continue;
    }
    if (!pb) {
      issues.push({ level: 'error', message: `Le port d'entrée « ${c.toPort} » n'existe pas sur « ${b.name} » (ou c'est une sortie).`, nodeId: b.id });
      continue;
    }
    if (pa.type !== pb.type) {
      issues.push({ level: 'error', message: `Câble interdit : ${pa.type} (${a.name}:${pa.name}) vers ${pb.type} (${b.name}:${pb.name}).`, nodeId: b.id });
    }
    const key = `${c.fromNode}|${c.fromPort}|${c.toNode}|${c.toPort}`;
    if (cableKeys.has(key)) {
      issues.push({ level: 'warning', message: `Câble en double : ${a.name}:${pa.name} vers ${b.name}:${pb.name}.`, nodeId: b.id });
    }
    cableKeys.add(key);
    connectedIn.add(`${c.toNode}|${c.toPort}`);
    connectedNodes.add(c.fromNode);
    connectedNodes.add(c.toNode);
  }

  // avertissement : plugin mono (une seule sortie audio) relié à un seul côté de la carte son
  for (const m of project.nodes) {
    if (m.kind !== 'plugin' || !m.plugin) continue;
    const outs = nodePorts(m, hw).outputs.filter((o) => o.type === 'audio');
    if (outs.length !== 1) continue;
    const out = (outs[0] as PortInfo).name;
    for (const d of project.nodes.filter((x) => x.kind === 'hw-out')) {
      const ins = nodePorts(d, hw).inputs.filter((i) => i.type === 'audio');
      if (ins.length < 2) continue;
      const pair = [ins[0] as PortInfo, ins[1] as PortInfo];
      const fed = pair.filter((x) => project.cables.some((c) => c.toNode === d.id && c.toPort === x.name && c.fromNode === m.id && c.fromPort === out));
      const other = pair.find((x) => !fed.includes(x));
      if (fed.length === 1 && other && !project.cables.some((c) => c.toNode === d.id && c.toPort === other.name)) {
        issues.push({ level: 'warning', message: `« ${m.name} » n'a qu'une sortie audio (mono) : « ${d.name} » ne reçoit le son que sur « ${fed[0]?.name} », « ${other.name} » reste muette (bouton « Mono → stéréo »).`, nodeId: m.id });
      }
    }
  }

  // avertissements : nœuds isolés, entrées audio non reliées
  for (const n of project.nodes) {
    if (!connectedNodes.has(n.id)) {
      issues.push({ level: 'warning', message: `« ${n.name} » n'est relié à rien.`, nodeId: n.id });
      continue;
    }
    if (n.kind === 'plugin' && n.plugin) {
      const free = nodePorts(n, hw).inputs.filter((x) => x.type === 'audio' && !connectedIn.has(`${n.id}|${x.name}`));
      if (free.length > 0 && free.length <= 2) {
        for (const p of free) issues.push({ level: 'warning', message: `L'entrée « ${p.name} » de « ${n.name} » n'est pas reliée.`, nodeId: n.id });
      } else if (free.length > 2) {
        issues.push({ level: 'warning', message: `« ${n.name} » : ${free.length} entrées audio non reliées (${free[0]?.name} à ${free[free.length - 1]?.name}).`, nodeId: n.id });
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------------------------------------------
// Export

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function endpoint(node: PatchNode, port: string): string {
  return `${groupName(node)}:${port}`;
}

/** Lignes <Connection> du projet (sous forme [source, cible]). */
export function connectionsOf(project: PatchProject): Array<[string, string]> {
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const out: Array<[string, string]> = [];
  for (const c of project.cables) {
    const a = byId.get(c.fromNode);
    const b = byId.get(c.toNode);
    if (a && b) out.push([endpoint(a, c.fromPort), endpoint(b, c.toPort)]);
  }
  return out;
}

export function patchbayBlock(connections: Array<[string, string]>, positionsXml = ''): string {
  let x = ' <Patchbay>\n';
  for (const [s, t] of connections) {
    x += '  <Connection>\n';
    x += `   <Source>${escapeXml(s)}</Source>\n`;
    x += `   <Target>${escapeXml(t)}</Target>\n`;
    x += '  </Connection>\n';
  }
  if (positionsXml) x += positionsXml;
  x += ' </Patchbay>\n';
  return x;
}

function pluginBlock(node: PatchNode): string {
  const p = node.plugin as DbPlugin;
  let x = `\n <!-- ${escapeXml(node.name).replace(/--/g, '- -')} -->\n <Plugin>\n  <Info>\n`;
  x += `   <Type>${escapeXml(p.type)}</Type>\n`;
  x += `   <Name>${escapeXml(node.name)}</Name>\n`;
  x += `   <Binary>${escapeXml(p.path)}</Binary>\n`;
  if (p.type === 'VST2') {
    x += `   <UniqueID>${p.uniqueId ?? 0}</UniqueID>\n`;
  } else {
    x += `   <Label>${escapeXml(p.label)}</Label>\n`;
  }
  x += '  </Info>\n\n  <Data>\n';
  x += `   <Active>${node.bypass ? 'No' : 'Yes'}</Active>\n`;
  x += '   <ControlChannel>1</ControlChannel>\n';
  x += '   <Options>0x3f9</Options>\n';
  if (node.program) x += `   <CurrentProgramIndex>${node.program.index}</CurrentProgramIndex>\n   <CurrentProgramName>${escapeXml(node.program.name)}</CurrentProgramName>\n`;
  if (node.chunk) x += `\n   <Chunk>\n${node.chunk}\n   </Chunk>\n`;
  x += '  </Data>\n </Plugin>\n';
  return x;
}

/** Canevas par défaut de Carla (3100 × 2400) : les boîtes sans position y sont posées au centre (1550, 1200). */
export const CARLA_CANVAS = { w: 3100, h: 2400 };

function approxSize(n: PatchNode, hw: HardwareProfile): { w: number; h: number } {
  const p = nodePorts(n, hw);
  return { w: 210, h: 28 + Math.max(p.inputs.length, p.outputs.length, 1) * 18 + 10 + (n.preset ? 18 : 0) };
}

/**
 * Positions des boîtes dans Carla. Avec `center`, TOUTES les boîtes (plugins et groupes de la carte son) sont écrites,
 * décalées pour que l'ensemble soit centré sur le canevas de Carla : la chaîne apparaît compacte, au milieu de l'écran.
 */
function positionsBlock(project: PatchProject, extraRaw = '', center = true): string {
  const plugins = project.nodes.filter((n) => n.kind === 'plugin' && n.plugin);
  const hwNodes = center ? project.nodes.filter((n) => n.kind !== 'plugin') : [];
  if (plugins.length + hwNodes.length === 0 && !extraRaw) return '';
  let dx = 0, dy = 0;
  const boxes = [...plugins, ...hwNodes];
  if (center && boxes.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of boxes) {
      const s = approxSize(n, project.hardware);
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + s.w); maxY = Math.max(maxY, n.y + s.h);
    }
    dx = Math.max(Math.round(CARLA_CANVAS.w / 2 - (minX + maxX) / 2), -Math.round(minX));
    dy = Math.max(Math.round(CARLA_CANVAS.h / 2 - (minY + maxY) / 2), -Math.round(minY));
  }
  let x = '  <Positions>\n';
  plugins.forEach((n, i) => {
    x += `   <Position x1="${Math.round(n.x + dx)}" y1="${Math.round(n.y + dy)}" pluginId="${i}">\n`;
    x += `    <Name>${escapeXml(n.name)}</Name>\n`;
    x += '   </Position>\n';
  });
  for (const n of hwNodes) {
    const px = Math.round(n.x + dx), py = Math.round(n.y + dy);
    x += `   <Position x1="${px}" y1="${py}" x2="${px}" y2="${py}">\n`; // côté sortie et côté entrée au même endroit
    x += `    <Name>${escapeXml(groupName(n))}</Name>\n`;
    x += '   </Position>\n';
  }
  if (!center) x += extraRaw;
  x += '  </Positions>\n';
  return x;
}

function patchActive(raw: string, active: boolean): string {
  return raw.replace(/<Active>(Yes|No)<\/Active>/, `<Active>${active ? 'Yes' : 'No'}</Active>`);
}

function rawPluginBlock(node: PatchNode): string {
  return `\n <!-- ${escapeXml(node.name).replace(/--/g, '- -')} -->\n ${patchActive(node.raw ?? '', !node.bypass)}\n`;
}

/** Projet ouvert : on garde l'en-tête, les blocs de plugins d'origine et la fin du fichier ; on réécrit le câblage. */
function exportWithBase(project: PatchProject, base: ProjectBase, withPositions: boolean, center: boolean): string {
  let x = base.head;
  for (const n of project.nodes.filter((k) => k.kind === 'plugin' && k.plugin)) x += n.raw ? rawPluginBlock(n) : pluginBlock(n);
  x += '\n' + patchbayBlock(connectionsOf(project), withPositions ? positionsBlock(project, base.hwPositions, center) : '');
  return x + base.tail;
}

/** Génère un .carxp complet. Lance d'abord validateProject() pour afficher les erreurs à l'utilisateur. */
export function exportCarxp(project: PatchProject, withPositions = true, opts: { center?: boolean } = {}): string {
  const center = opts.center !== false;
  if (project.base) return exportWithBase(project, project.base, withPositions, center);
  const e: EngineSettings = { ...DEFAULT_ENGINE, ...(project.engine || {}) };
  const yn = (b: boolean) => (b ? 'true' : 'false');
  let x = "<?xml version='1.0' encoding='UTF-8'?>\n<!DOCTYPE CARLA-PROJECT>\n<CARLA-PROJECT VERSION='2.5'>\n";
  x += ' <EngineSettings>\n';
  x += `  <ForceStereo>${yn(e.forceStereo)}</ForceStereo>\n`;
  x += `  <PreferPluginBridges>${yn(e.preferPluginBridges)}</PreferPluginBridges>\n`;
  x += `  <PreferUiBridges>${yn(e.preferUiBridges)}</PreferUiBridges>\n`;
  x += `  <UIsAlwaysOnTop>${yn(e.uisAlwaysOnTop)}</UIsAlwaysOnTop>\n`;
  x += `  <MaxParameters>${e.maxParameters}</MaxParameters>\n`;
  x += `  <UIBridgesTimeout>${e.uiBridgesTimeout}</UIBridgesTimeout>\n`;
  x += ' </EngineSettings>\n\n';
  x += ` <Transport>\n  <BeatsPerMinute>${project.bpm ?? 120}</BeatsPerMinute>\n </Transport>\n`;

  for (const n of project.nodes.filter((k) => k.kind === 'plugin' && k.plugin)) x += pluginBlock(n);

  x += '\n' + patchbayBlock(connectionsOf(project), withPositions ? positionsBlock(project, '', center) : '');
  x += '</CARLA-PROJECT>\n';
  return x;
}

// ------------------------------------------------------------------------------------------------
// Import d'un .carxp existant

export interface ImportedPlugin {
  type: string;
  name: string;
  binary: string;
  label: string;
  uniqueId: number | null;
  active: boolean;
  chunk: string; // base64 d'origine, sans retouche
  programIndex?: number;
  programName?: string;
}

export interface ImportedCarxp {
  bpm: number | null;
  plugins: ImportedPlugin[];
  connections: Array<[string, string]>;
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? unescapeXml(m[1].trim()) : null;
}

export function importCarxp(xml: string): ImportedCarxp {
  const plugins: ImportedPlugin[] = [];
  const re = /<Plugin>([\s\S]*?)<\/Plugin>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const info = /<Info>([\s\S]*?)<\/Info>/.exec(b)?.[1] ?? '';
    const data = /<Data>([\s\S]*?)<\/Data>/.exec(b)?.[1] ?? '';
    const uid = tag(info, 'UniqueID');
    plugins.push({
      type: tag(info, 'Type') ?? '',
      name: tag(info, 'Name') ?? '',
      binary: tag(info, 'Binary') ?? '',
      label: tag(info, 'Label') ?? '',
      uniqueId: uid ? Number(uid) : null,
      active: (tag(data, 'Active') ?? 'Yes') === 'Yes',
      chunk: (/<Chunk>([\s\S]*?)<\/Chunk>/.exec(data)?.[1] ?? '').trim(),
      ...(tag(data, 'CurrentProgramIndex') !== null ? { programIndex: Number(tag(data, 'CurrentProgramIndex')), programName: tag(data, 'CurrentProgramName') ?? '' } : {}),
    });
  }

  const pb = /<Patchbay>([\s\S]*?)<\/Patchbay>/.exec(xml)?.[1] ?? '';
  const connections: Array<[string, string]> = [];
  const rc = /<Connection>\s*<Source>([\s\S]*?)<\/Source>\s*<Target>([\s\S]*?)<\/Target>\s*<\/Connection>/g;
  while ((m = rc.exec(pb))) connections.push([unescapeXml(m[1].trim()), unescapeXml(m[2].trim())]);

  const bpm = tag(xml, 'BeatsPerMinute');
  return { bpm: bpm ? Number(bpm) : null, plugins, connections };
}

/**
 * Réécrit UNIQUEMENT la section <Patchbay> d'un .carxp existant.
 * Les plugins, leurs réglages et leurs états (Chunk) restent identiques octet pour octet.
 * L'ancienne section <ExternalPatchbay> (connexions MIDI externes) est conservée.
 */
export function rewritePatchbay(xml: string, connections: Array<[string, string]>): string {
  const re = / ?<Patchbay>[\s\S]*?<\/Patchbay>\n?/;
  const ancien = /<Patchbay>([\s\S]*?)<\/Patchbay>/.exec(xml);
  // on garde les positions des boîtes déjà enregistrées dans le projet
  const positions = ancien ? (/( *<Positions>[\s\S]*?<\/Positions>\n?)/.exec(ancien[1])?.[1] ?? '') : '';
  const bloc = patchbayBlock(connections, positions);
  if (re.test(xml)) return xml.replace(re, () => bloc);
  return xml.replace('</CARLA-PROJECT>', () => '\n' + bloc + '</CARLA-PROJECT>');
}
