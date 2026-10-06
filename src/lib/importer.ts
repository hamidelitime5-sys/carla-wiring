// src/lib/importer.ts : ouvre un projet Carla (.carxp) pour le modifier dans le Patchbay.
//
// Garanties : les blocs <Plugin> (réglages, états sauvegardés) sont conservés tels quels ; l'en-tête
// (EngineSettings, Transport…) et la fin du fichier (ExternalPatchbay…) aussi. Seul le câblage est réécrit.
import { importCarxp, unescapeXml, type DbPlugin, type HardwareProfile, type PatchCable, type PatchNode, type PatchProject, type ProjectBase } from './carxp';
import { autoLayout, HW_NAMES, type HwKind } from './editor';
import { checkVc2State } from './vst3state';

export interface OpenResult {
  project: PatchProject;
  hardware: HardwareProfile;
  warnings: string[];
  unmatched: string[]; // plugins du projet absents de la base (ports déduits des câbles)
}

const HW_GROUPS: Array<[string, HwKind]> = [['Audio Input', 'hw-in'], ['Audio Output', 'hw-out'], ['Midi Input', 'midi-in']];
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** Découpe le fichier : en-tête, blocs de plugins, câblage, fin. */
export function splitProject(xml: string): { base: ProjectBase; plugins: string[] } {
  const pbStart = xml.indexOf('<Patchbay>');
  const pbEndTag = xml.indexOf('</Patchbay>');
  const hasPb = pbStart >= 0 && pbEndTag > pbStart;
  const regionEnd = hasPb ? pbStart : xml.length;
  const region = xml.slice(0, regionEnd);

  const plugins = region.match(/<Plugin>[\s\S]*?<\/Plugin>/g) ?? [];
  const firstPlugin = region.indexOf('<Plugin>');
  const lineStart = (i: number): number => xml.lastIndexOf('\n', i) + 1;

  let headEnd: number;
  if (firstPlugin >= 0) {
    const c = region.lastIndexOf('<!--', firstPlugin);
    headEnd = c >= 0 && /^<!--[\s\S]*?-->\s*$/.test(region.slice(c, firstPlugin)) ? lineStart(c) : lineStart(firstPlugin);
  } else {
    headEnd = hasPb ? lineStart(pbStart) : (xml.lastIndexOf('</CARLA-PROJECT>') >= 0 ? xml.lastIndexOf('</CARLA-PROJECT>') : xml.length);
  }
  let tailStart: number;
  if (hasPb) tailStart = pbEndTag + '</Patchbay>'.length;
  else {
    const lastEnd = region.lastIndexOf('</Plugin>');
    tailStart = lastEnd >= 0 ? lastEnd + '</Plugin>'.length : headEnd;
  }
  const head = xml.slice(0, headEnd);
  const tail = xml.slice(tailStart).replace(/^\s*\n/, '\n');

  // positions des groupes matériel, conservées telles quelles
  let hwPositions = '';
  if (hasPb) {
    const inner = xml.slice(pbStart, pbEndTag);
    for (const m of inner.match(/[ \t]*<Position\b[^>]*>[\s\S]*?<\/Position>\n?/g) ?? []) {
      const name = /<Name>([\s\S]*?)<\/Name>/.exec(m)?.[1];
      if (name && HW_GROUPS.some(([g]) => g === unescapeXml(name.trim()))) hwPositions += m.endsWith('\n') ? m : m + '\n';
    }
  }
  return { base: { head, tail, hwPositions }, plugins: [...plugins] };
}

export function matchDb(db: DbPlugin[], file: { binary: string; name: string; type: string }): DbPlugin | undefined {
  const byPath = file.binary ? db.find((p) => p.path && norm(p.path) === norm(file.binary)) : undefined;
  return byPath ?? db.find((p) => p.name === file.name && p.type === file.type) ?? db.find((p) => p.name === file.name);
}

/** Ports réellement utilisés par les câbles du fichier pour un plugin (pour les plugins absents de la base). */
function inferPorts(name: string, connections: Array<[string, string]>): { ins: number; outs: number; midiIn: boolean; midiOut: boolean } {
  let ins = 0, outs = 0, midiIn = false, midiOut = false;
  const prefix = `${name}:`;
  for (const [src, dst] of connections) {
    if (src.startsWith(prefix)) {
      const port = src.slice(prefix.length);
      const m = /^output_(\d+)$/.exec(port);
      if (m) outs = Math.max(outs, Number(m[1]));
      if (port === 'events-out') midiOut = true;
    }
    if (dst.startsWith(prefix)) {
      const port = dst.slice(prefix.length);
      const m = /^input_(\d+)$/.exec(port);
      if (m) ins = Math.max(ins, Number(m[1]));
      if (port === 'events-in') midiIn = true;
    }
  }
  return { ins, outs, midiIn, midiOut };
}

export function projectFromCarxp(xml: string, db: DbPlugin[], current: HardwareProfile): OpenResult {
  const imp = importCarxp(xml);
  const { base, plugins: raws } = splitProject(xml);
  const warnings: string[] = [];
  const unmatched: string[] = [];
  if (imp.plugins.length === 0 && imp.connections.length === 0) warnings.push('Ce projet ne contient ni plugin ni câble.');

  const nodes: PatchNode[] = [];
  imp.plugins.forEach((fp, i) => {
    const used = inferPorts(fp.name, imp.connections);
    const hit = matchDb(db, { binary: fp.binary, name: fp.name, type: fp.type });
    let plugin: DbPlugin;
    if (hit) {
      plugin = { ...hit, audioIns: Math.max(hit.audioIns, used.ins), audioOuts: Math.max(hit.audioOuts, used.outs), midiIns: Math.max(hit.midiIns, used.midiIn ? 1 : 0), midiOuts: Math.max(hit.midiOuts, used.midiOut ? 1 : 0) };
    } else {
      unmatched.push(fp.name);
      plugin = { type: fp.type, name: fp.name, label: fp.label, maker: '', path: fp.binary, uniqueId: fp.uniqueId, category: '', isSynth: false,
        audioIns: used.ins, audioOuts: used.outs, midiIns: used.midiIn ? 1 : 0, midiOuts: used.midiOut ? 1 : 0 };
    }
    nodes.push({ id: `n${i + 1}`, kind: 'plugin', name: fp.name, plugin, raw: raws[i], chunk: fp.chunk || undefined, ...(fp.programIndex !== undefined ? { program: { index: fp.programIndex, name: fp.programName ?? '' } } : {}), bypass: !fp.active, x: 0, y: 0 });
  });
  for (const fp of imp.plugins) {
    const chk = checkVc2State(fp.chunk);
    if (!chk.ok) warnings.push(`L'état enregistré de « ${fp.name.replace(/&apos;/g, "'")} » est abîmé (${chk.problem}) : le plugin ne chargera pas ce preset, il repartira de ses réglages d'usine.`);
  }
  if (raws.length !== imp.plugins.length) warnings.push('Structure inhabituelle : certains blocs de plugins n\'ont pas pu être associés.');
  for (const n of unmatched) warnings.push(`« ${n} » n'est pas dans votre base de plugins : ses ports sont déduits des câbles existants (les ports inutilisés peuvent manquer).`);

  // extrémités des câbles
  const hwPorts: Record<HwKind, string[]> = { 'hw-in': [], 'hw-out': [], 'midi-in': [] };
  const byNameLen = [...nodes].sort((a, b) => b.name.length - a.name.length);
  const hwNodes = new Map<HwKind, PatchNode>();
  const hwNode = (kind: HwKind): PatchNode => {
    let n = hwNodes.get(kind);
    if (!n) { n = { id: `n${nodes.length + 1}`, kind, name: HW_NAMES[kind], x: 0, y: 0 }; hwNodes.set(kind, n); nodes.push(n); }
    return n;
  };
  const resolve = (e: string): { node: PatchNode; port: string } | null => {
    for (const [group, kind] of HW_GROUPS) {
      if (e.startsWith(`${group}:`)) {
        const port = e.slice(group.length + 1);
        if (!hwPorts[kind].includes(port)) hwPorts[kind].push(port);
        return { node: hwNode(kind), port };
      }
    }
    const n = byNameLen.find((x) => e.startsWith(`${x.name}:`));
    return n ? { node: n, port: e.slice(n.name.length + 1) } : null;
  };
  const cables: PatchCable[] = [];
  for (const [s, t] of imp.connections) {
    const a = resolve(s); const b = resolve(t);
    if (!a || !b) { warnings.push(`Câble ignoré (extrémité inconnue) : ${s} → ${t}`); continue; }
    cables.push({ fromNode: a.node.id, fromPort: a.port, toNode: b.node.id, toPort: b.port });
  }

  // les noms de ports de la carte du projet font foi pour votre Carla
  const hardware: HardwareProfile = {
    name: current.name,
    audioIn: hwPorts['hw-in'].length ? hwPorts['hw-in'] : current.audioIn,
    audioOut: hwPorts['hw-out'].length ? hwPorts['hw-out'] : current.audioOut,
    midiIn: hwPorts['midi-in'].length ? hwPorts['midi-in'] : current.midiIn,
  };
  const project: PatchProject = { nodes, cables, hardware, base };
  autoLayout(project);
  return { project, hardware, warnings, unmatched };
}
