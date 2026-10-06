// src/lib/editor.ts : opérations pures sur un patchbay (ajout, suppression, connexion, disposition).
// Aucune dépendance à l'interface : tout est testable.
import { nodePorts, type DbPlugin, type HardwareProfile, type PatchNode, type PatchProject, type PortInfo } from './carxp';

export const NODE_W = 210;
export const ROW_H = 18;
export const HEAD_H = 28;
export const COL_GAP = 70;
export const PAD = 20;

export type HwKind = 'hw-in' | 'hw-out' | 'midi-in';
export const HW_NAMES: Record<HwKind, string> = { 'hw-in': 'Audio Input', 'hw-out': 'Audio Output', 'midi-in': 'Midi Input' };

export const emptyProject = (hardware: HardwareProfile): PatchProject => ({ nodes: [], cables: [], hardware });

export function nodeHeight(n: PatchNode, hw: HardwareProfile): number {
  const p = nodePorts(n, hw);
  return HEAD_H + Math.max(p.inputs.length, p.outputs.length, 1) * ROW_H + 10 + (n.preset ? ROW_H : 0);
}

export function uniqueName(p: PatchProject, base: string): string {
  const taken = new Set(p.nodes.map((n) => n.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  return `${base} ${Date.now()}`;
}

function newId(p: PatchProject): string {
  let i = p.nodes.length + 1;
  while (p.nodes.some((n) => n.id === `n${i}`)) i++;
  return `n${i}`;
}

export function addPlugin(p: PatchProject, plugin: DbPlugin): PatchNode {
  const node: PatchNode = { id: newId(p), kind: 'plugin', name: uniqueName(p, plugin.name), plugin, x: PAD, y: PAD };
  p.nodes.push(node);
  return node;
}

/** Ajoute (ou renvoie) le nœud matériel : il n'en existe qu'un de chaque sorte. */
export function ensureHardware(p: PatchProject, kind: HwKind): PatchNode {
  const found = p.nodes.find((n) => n.kind === kind);
  if (found) return found;
  const node: PatchNode = { id: newId(p), kind, name: HW_NAMES[kind], x: PAD, y: PAD };
  p.nodes.push(node);
  return node;
}

export function removeNode(p: PatchProject, id: string): void {
  p.nodes = p.nodes.filter((n) => n.id !== id);
  p.cables = p.cables.filter((c) => c.fromNode !== id && c.toNode !== id);
}

export interface Endpoint { node: string; port: string }

function portOf(p: PatchProject, e: Endpoint): { input?: PortInfo; output?: PortInfo; node?: PatchNode } {
  const node = p.nodes.find((n) => n.id === e.node);
  if (!node) return {};
  const ports = nodePorts(node, p.hardware);
  return { node, input: ports.inputs.find((x) => x.name === e.port), output: ports.outputs.find((x) => x.name === e.port) };
}

/** Relie deux ports (dans n'importe quel ordre). Renvoie un message d'erreur, ou null si le câble a été créé. */
export function connect(p: PatchProject, a: Endpoint, b: Endpoint): string | null {
  const pa = portOf(p, a);
  const pb = portOf(p, b);
  if (!pa.node || !pb.node) return 'Port introuvable.';
  if (a.node === b.node) return 'Impossible de relier un plugin à lui-même.';
  let from: Endpoint, to: Endpoint, fi: PortInfo | undefined, ti: PortInfo | undefined;
  if (pa.output && pb.input) { from = a; to = b; fi = pa.output; ti = pb.input; }
  else if (pb.output && pa.input) { from = b; to = a; fi = pb.output; ti = pa.input; }
  else if (pa.output && pb.output) return 'Deux sorties ne peuvent pas être reliées : choisissez une sortie et une entrée.';
  else return 'Deux entrées ne peuvent pas être reliées : choisissez une sortie et une entrée.';
  if (!fi || !ti) return 'Port introuvable.';
  if (fi.type !== ti.type) return `Câble refusé : ${fi.type === 'audio' ? 'audio' : 'MIDI'} vers ${ti.type === 'audio' ? 'audio' : 'MIDI'}.`;
  if (p.cables.some((c) => c.fromNode === from.node && c.fromPort === from.port && c.toNode === to.node && c.toPort === to.port)) return 'Ce câble existe déjà.';
  p.cables.push({ fromNode: from.node, fromPort: from.port, toNode: to.node, toPort: to.port });
  return null;
}

export function disconnect(p: PatchProject, index: number): void {
  if (index >= 0 && index < p.cables.length) p.cables.splice(index, 1);
}

/** Dispose les nœuds en colonnes selon le sens du signal (entrées à gauche, sortie à droite). */
export function autoLayout(p: PatchProject): void {
  const depth = new Map<string, number>(p.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < p.nodes.length + 1; pass++) {
    let changed = false;
    for (const c of p.cables) {
      const d = (depth.get(c.fromNode) ?? 0) + 1;
      if (d > (depth.get(c.toNode) ?? 0) && d <= p.nodes.length) { depth.set(c.toNode, d); changed = true; }
    }
    if (!changed) break;
  }
  const columns = new Map<number, PatchNode[]>();
  for (const n of p.nodes) {
    const d = depth.get(n.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  for (const [d, nodes] of columns) {
    let y = PAD;
    for (const n of nodes) {
      n.x = PAD + d * (NODE_W + COL_GAP);
      n.y = y;
      y += nodeHeight(n, p.hardware) + 24;
    }
  }
}

export function contentSize(p: PatchProject): { w: number; h: number } {
  let w = 600, h = 300;
  for (const n of p.nodes) {
    w = Math.max(w, n.x + NODE_W + PAD * 2);
    h = Math.max(h, n.y + nodeHeight(n, p.hardware) + PAD * 2);
  }
  return { w, h };
}

// ---------------------------------------------------------------------------------------------
// Remplacer un plugin par un autre en gardant les câbles compatibles

export interface ReplaceResult {
  error?: string;
  kept: number; // câbles conservés
  dropped: string[]; // câbles abandonnés (port absent du nouveau plugin)
}

export function replacePlugin(p: PatchProject, nodeId: string, plugin: DbPlugin): ReplaceResult {
  const node = p.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'plugin') return { error: 'Seul un plugin peut être remplacé (pas une entrée ou une sortie de la carte).', kept: 0, dropped: [] };
  if (node.plugin && node.plugin.path === plugin.path && node.plugin.name === plugin.name) return { error: `« ${node.name} » est déjà ce plugin.`, kept: 0, dropped: [] };
  const ports = nodePorts({ ...node, plugin }, p.hardware);
  const nameOf = (id: string): string => p.nodes.find((n) => n.id === id)?.name ?? id;
  let kept = 0;
  const dropped: string[] = [];
  const cables = p.cables.filter((c) => {
    const touchesOut = c.fromNode === nodeId;
    const touchesIn = c.toNode === nodeId;
    if (!touchesOut && !touchesIn) return true;
    const ok = (!touchesOut || ports.outputs.some((x) => x.name === c.fromPort)) && (!touchesIn || ports.inputs.some((x) => x.name === c.toPort));
    if (ok) kept++; else dropped.push(`${nameOf(c.fromNode)}:${c.fromPort} → ${nameOf(c.toNode)}:${c.toPort}`);
    return ok;
  });
  const others = new Set(p.nodes.filter((n) => n.id !== nodeId).map((n) => n.name.toLowerCase()));
  let name = plugin.name; let k = 2;
  while (others.has(name.toLowerCase())) name = `${plugin.name} ${k++}`;
  node.name = name; node.plugin = plugin;
  delete node.raw; delete node.chunk; // les réglages sauvegardés de l'ancien plugin ne valent pas pour le nouveau
  p.cables = cables;
  return { kept, dropped };
}

// ---------------------------------------------------------------------------------------------
// Organisation à la main : couleurs, alignement, répartition, grille

export const COLORS = ['#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#60a5fa', '#f87171'];

export function setColor(p: PatchProject, ids: string[], color: string | undefined): number {
  let n = 0;
  for (const node of p.nodes) if (ids.includes(node.id)) { if (color) node.color = color; else delete node.color; n++; }
  return n;
}

export function nodeSize(n: PatchNode, hw: HardwareProfile): { w: number; h: number } {
  return { w: NODE_W, h: nodeHeight(n, hw) };
}

export function moveNodes(p: PatchProject, ids: string[], dx: number, dy: number): void {
  for (const n of p.nodes) if (ids.includes(n.id)) { n.x = Math.max(0, n.x + dx); n.y = Math.max(0, n.y + dy); }
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

/** Aligne les boîtes choisies (au moins 2) sur le bord ou le centre de l'ensemble. */
export function alignNodes(p: PatchProject, ids: string[], mode: AlignMode): number {
  const sel = p.nodes.filter((n) => ids.includes(n.id));
  if (sel.length < 2) return 0;
  const minX = Math.min(...sel.map((n) => n.x)), maxR = Math.max(...sel.map((n) => n.x + NODE_W));
  const minY = Math.min(...sel.map((n) => n.y)), maxB = Math.max(...sel.map((n) => n.y + nodeHeight(n, p.hardware)));
  for (const n of sel) {
    const h = nodeHeight(n, p.hardware);
    if (mode === 'left') n.x = minX;
    else if (mode === 'right') n.x = maxR - NODE_W;
    else if (mode === 'centerX') n.x = Math.round((minX + maxR) / 2 - NODE_W / 2);
    else if (mode === 'top') n.y = minY;
    else if (mode === 'bottom') n.y = maxB - h;
    else n.y = Math.round((minY + maxB) / 2 - h / 2);
  }
  return sel.length;
}

/** Répartit régulièrement (au moins 3 boîtes) : les extrémités ne bougent pas. */
export function distributeNodes(p: PatchProject, ids: string[], axis: 'x' | 'y'): number {
  const sel = p.nodes.filter((n) => ids.includes(n.id));
  if (sel.length < 3) return 0;
  const size = (n: PatchNode): number => (axis === 'x' ? NODE_W : nodeHeight(n, p.hardware));
  const pos = (n: PatchNode): number => (axis === 'x' ? n.x : n.y);
  const sorted = [...sel].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0] as PatchNode, last = sorted[sorted.length - 1] as PatchNode;
  const span = pos(last) + size(last) - pos(first);
  const gap = (span - sorted.reduce((s, n) => s + size(n), 0)) / (sorted.length - 1);
  let cur = pos(first);
  for (const n of sorted) {
    if (axis === 'x') n.x = Math.round(cur); else n.y = Math.round(cur);
    cur += size(n) + gap;
  }
  return sel.length;
}

export function snapNodes(p: PatchProject, ids: string[], grid = 20): void {
  for (const n of p.nodes) if (ids.includes(n.id)) { n.x = Math.max(0, Math.round(n.x / grid) * grid); n.y = Math.max(0, Math.round(n.y / grid) * grid); }
}

export function boundingBox(p: PatchProject, ids?: string[]): { x: number; y: number; w: number; h: number } | null {
  const sel = p.nodes.filter((n) => !ids || ids.includes(n.id));
  if (!sel.length) return null;
  const x = Math.min(...sel.map((n) => n.x)), y = Math.min(...sel.map((n) => n.y));
  const r = Math.max(...sel.map((n) => n.x + NODE_W)), b = Math.max(...sel.map((n) => n.y + nodeHeight(n, p.hardware)));
  return { x, y, w: r - x, h: b - y };
}

export const ROLE_COLORS = { instrument: '#fbbf24', effect: '#22d3ee', hardware: '#8b97a5' };

/** Colore toute la chaîne selon le rôle : instruments (ambre), effets (cyan), entrées/sorties de la carte (gris). */
export function colorByRole(p: PatchProject): number {
  for (const n of p.nodes) n.color = n.kind !== 'plugin' ? ROLE_COLORS.hardware : n.plugin?.isSynth ? ROLE_COLORS.instrument : ROLE_COLORS.effect;
  return p.nodes.length;
}

/**
 * Mono → stéréo. Un plugin qui n'a qu'UNE sortie audio (ex. ReValver) ne donne du son que d'un côté s'il n'est relié qu'à
 * une des deux entrées de sa destination. Si l'une des deux premières entrées de la destination est alimentée par cette sortie
 * et que l'autre ne reçoit rien, la même sortie est reliée aux deux. Les entrées suivantes (ex. chaîne latérale) ne sont jamais touchées.
 * Renvoie le nombre de câbles ajoutés.
 */
export function fanOutMono(p: PatchProject): number {
  let added = 0;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  for (const m of p.nodes) {
    if (m.kind !== 'plugin') continue;
    const outs = nodePorts(m, p.hardware).outputs.filter((o) => o.type === 'audio');
    if (outs.length !== 1) continue;
    const out = (outs[0] as PortInfo).name;
    const dests = new Set(p.cables.filter((c) => c.fromNode === m.id && c.fromPort === out).map((c) => c.toNode));
    for (const did of dests) {
      const d = byId.get(did);
      if (!d) continue;
      const ins = nodePorts(d, p.hardware).inputs.filter((i) => i.type === 'audio');
      if (ins.length < 2) continue;
      const pair = [ins[0] as PortInfo, ins[1] as PortInfo];
      const fedBy = (x: PortInfo): boolean => p.cables.some((c) => c.toNode === d.id && c.toPort === x.name && c.fromNode === m.id && c.fromPort === out);
      const fed = pair.filter(fedBy);
      if (fed.length !== 1) continue;
      const other = pair.find((x) => !fedBy(x)) as PortInfo;
      if (p.cables.some((c) => c.toNode === d.id && c.toPort === other.name)) continue; // déjà alimentée par autre chose
      if (!connect(p, { node: m.id, port: out }, { node: d.id, port: other.name })) added++;
    }
  }
  return added;
}
