// src/lib/patchbay.ts : vue SVG interactive du patchbay.
//   - TIRER un câble : appuyer sur un port, glisser jusqu'à un autre port, relâcher (ou : clic sur un port, puis clic sur un autre)
//   - sélectionner : clic sur l'en-tête d'une boîte, Maj+clic pour en ajouter, ou cadre tiré sur le fond ; Ctrl+A = tout
//   - déplacer : glisser l'en-tête (toutes les boîtes sélectionnées suivent)
//   - supprimer un câble : double-clic dessus (ou clic puis Suppr) ; supprimer des boîtes : les sélectionner puis Suppr
//   - ⏻ contourne un plugin ; ⇄ le remplace ; × le supprime ; Ctrl+molette = zoom
import { nodePorts, type PatchNode, type PatchProject } from './carxp';
import { boundingBox, connect, contentSize, disconnect, nodeHeight, removeNode, snapNodes, HEAD_H, NODE_W, ROW_H, type Endpoint } from './editor';

const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c'];

type Kind = 'ok' | 'err' | 'info';

/** Port pouvant recevoir le câble en cours de tracé. */
interface PortCand { node: string; port: string; x: number; y: number; el: Element }

/** Rayon d'aimantation, en pixels d'écran : le câble se colle au port compatible le plus proche dans ce rayon. */
const SNAP_PX = 34;

export interface PatchbayView {
  render(): void;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  getZoom(): number;
  setZoom(z: number): void;
  center(): void;
}

export interface PatchbayOptions {
  onChange: () => void;
  onMessage: (msg: string, kind: Kind) => void;
  onReplace?: (nodeId: string) => void;
  onSelect?: (ids: string[]) => void;
  onColor?: (nodeId: string, clientX: number, clientY: number) => void; // clic sur le point de couleur d'une boîte
  snap?: () => boolean; // aimanter les boîtes à la grille après un déplacement
}

function mk(tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e as SVGElement;
}

export function mountPatchbay(host: HTMLElement, get: () => PatchProject, opts: PatchbayOptions): PatchbayView {
  const svg = mk('svg', { class: 'graph editor', 'data-id': 'patchbay' });
  host.replaceChildren(svg);

  let pending: Endpoint | null = null; // premier port cliqué (mode clic-clic)
  let selectedCable: number | null = null;
  let selection = new Set<string>();
  let zoom = 1;
  let swallowClick = false;
  let drag: { sx: number; sy: number; starts: Map<string, { x: number; y: number }>; moved: boolean; collapseTo?: string } | null = null;
  let link: { from: Endpoint; side: string; sx: number; sy: number; moved: boolean; line: SVGElement | null; cands: PortCand[]; snap: PortCand | null } | null = null;
  let rubber: { x0: number; y0: number; moved: boolean; el: SVGElement | null; additive: boolean } | null = null;

  const portIndex = (n: PatchNode, hw: PatchProject['hardware'], port: string, side: 'inputs' | 'outputs'): number =>
    Math.max(0, nodePorts(n, hw)[side].findIndex((p) => p.name === port));
  const portY = (n: PatchNode, i: number): number => n.y + HEAD_H + (i + 0.5) * ROW_H + 2;
  const colorOf = (p: PatchProject, id: string): string => {
    const n = p.nodes.find((x) => x.id === id);
    return n?.color ?? PALETTE[Math.max(0, p.nodes.findIndex((x) => x.id === id)) % PALETTE.length] ?? '#22d3ee';
  };
  const toSvg = (ev: MouseEvent): { x: number; y: number } => {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
  };
  const notifySelect = (): void => opts.onSelect?.([...selection]);
  function setSel(ids: string[]): void {
    const valid = new Set(get().nodes.map((n) => n.id));
    selection = new Set(ids.filter((i) => valid.has(i)));
    notifySelect(); render();
  }

  const clickPort = (p: PatchProject, e: Endpoint): void => {
    selectedCable = null;
    if (!pending) { pending = e; render(); opts.onMessage('Cliquez maintenant sur le port à relier (Échap pour annuler), ou glissez directement d\'un port à l\'autre.', 'info'); return; }
    if (pending.node === e.node && pending.port === e.port) { pending = null; render(); return; }
    const err = connect(p, pending, e);
    pending = null;
    if (err) { opts.onMessage(err, 'err'); render(); return; }
    opts.onMessage('Câble créé.', 'ok');
    render(); opts.onChange();
  };

  function startDrag(ev: MouseEvent): void {
    const p = get();
    const starts = new Map<string, { x: number; y: number }>();
    for (const n of p.nodes) if (selection.has(n.id)) starts.set(n.id, { x: n.x, y: n.y });
    drag = { sx: ev.clientX, sy: ev.clientY, starts, moved: false };
  }

  function startLink(ev: MouseEvent, from: Endpoint): void {
    // met en retrait les ports qui ne peuvent pas recevoir ce câble (même côté, ou type différent) et mémorise les autres
    const start = [...svg.querySelectorAll('circle.port')].find((c) => c.getAttribute('data-node') === from.node && c.getAttribute('data-port') === from.port);
    const side = start?.getAttribute('data-side') ?? ''; const isMidi = !!start?.classList.contains('midi');
    const cands: PortCand[] = [];
    for (const c of svg.querySelectorAll('circle.port')) {
      const compatible = c.getAttribute('data-side') !== side && c.classList.contains('midi') === isMidi && c.getAttribute('data-node') !== from.node;
      if (!compatible) { c.classList.add('dim'); continue; }
      cands.push({ node: c.getAttribute('data-node') ?? '', port: c.getAttribute('data-port') ?? '', x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')), el: c });
    }
    link = { from, side, sx: ev.clientX, sy: ev.clientY, moved: false, line: null, cands, snap: null };
  }

  /** Cible aimantée : sur une boîte, son port compatible le plus proche ; sinon le port compatible le plus proche dans le rayon d'aimantation. */
  function snapTarget(pt: { x: number; y: number }): PortCand | null {
    if (!link) return null;
    const p = get();
    const over = [...p.nodes].reverse().find((n) => pt.x >= n.x - 8 && pt.x <= n.x + NODE_W + 8 && pt.y >= n.y && pt.y <= n.y + nodeHeight(n, p.hardware));
    const pool = over ? link.cands.filter((c) => c.node === over.id) : link.cands;
    const limit = over ? Infinity : SNAP_PX / zoom;
    let best: PortCand | null = null, bestD = limit;
    for (const c of pool) { const d = Math.hypot(c.x - pt.x, c.y - pt.y); if (d <= bestD) { best = c; bestD = d; } }
    return best;
  }

  /** Coupe les noms trop longs avec « … » d'après leur largeur réelle, pour qu'ils ne passent pas sous les boutons. */
  function fitTitles(): void {
    for (const t of svg.querySelectorAll<SVGTextContentElement>('text.gtitle')) {
      if (typeof t.getComputedTextLength !== 'function') continue; // pas de mesure possible (tests, bureau caché) : nom complet
      const max = Number(t.getAttribute('data-max')); const full = t.getAttribute('data-full') ?? '';
      let s = full;
      try { while (s.length > 3 && t.getComputedTextLength() > max) { s = s.slice(0, -1); t.textContent = `${s.trimEnd()}…`; } } catch { /* élément non affiché */ }
    }
  }

  function render(): void {
    const p = get();
    for (const id of [...selection]) if (!p.nodes.some((n) => n.id === id)) selection.delete(id);
    const size = contentSize(p);
    svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    svg.setAttribute('width', String(Math.round(size.w * zoom))); svg.setAttribute('height', String(Math.round(size.h * zoom)));
    const items: SVGElement[] = [];
    const byId = new Map(p.nodes.map((n) => [n.id, n]));

    p.cables.forEach((c, index) => {
      const a = byId.get(c.fromNode); const b = byId.get(c.toNode); if (!a || !b) return;
      const x1 = a.x + NODE_W, y1 = portY(a, portIndex(a, p.hardware, c.fromPort, 'outputs'));
      const x2 = b.x, y2 = portY(b, portIndex(b, p.hardware, c.toPort, 'inputs'));
      const dx = Math.max(40, Math.abs(x2 - x1) / 2);
      const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      const g = mk('g', { class: 'cableg', 'data-index': index });
      g.append(mk('path', { class: selectedCable === index ? 'cable sel' : 'cable', d, stroke: colorOf(p, c.fromNode) }), mk('path', { class: 'hit', d }));
      g.addEventListener('click', (ev) => { ev.stopPropagation(); selectedCable = selectedCable === index ? null : index; pending = null; render(); });
      g.addEventListener('dblclick', (ev) => { ev.stopPropagation(); disconnect(p, index); selectedCable = null; render(); opts.onChange(); opts.onMessage('Câble supprimé.', 'ok'); });
      items.push(g);
    });

    for (const n of p.nodes) {
      const ports = nodePorts(n, p.hardware);
      const h = nodeHeight(n, p.hardware);
      const g = mk('g', { class: `node${n.bypass ? ' bypass' : ''}${selection.has(n.id) ? ' sel' : ''}`, 'data-node': n.id });
      const tip = n.plugin ? `${n.name} — ${n.plugin.type}${n.plugin.path ? ` — ${n.plugin.path}` : ''}${n.preset ? ` — preset : ${n.preset.name}` : ''}` : n.name;
      g.append(mk('title', {}, tip));
      g.append(mk('rect', { class: 'gnode', x: n.x, y: n.y, width: NODE_W, height: h, rx: 6, ...(n.color ? { style: `stroke:${n.color};stroke-width:2.8` } : {}) }));
      const head = mk('rect', { class: 'ghead', x: n.x, y: n.y, width: NODE_W, height: HEAD_H, rx: 6, ...(n.color ? { style: `fill:${n.color};fill-opacity:.55` } : {}) });
      head.addEventListener('mousedown', (ev) => {
        const me = ev as MouseEvent;
        if (me.button !== 0) return;
        ev.preventDefault(); ev.stopPropagation(); swallowClick = false;
        if (me.shiftKey || me.ctrlKey || me.metaKey) { const ids = new Set(selection); if (ids.has(n.id)) ids.delete(n.id); else ids.add(n.id); setSel([...ids]); return; }
        if (!selection.has(n.id)) setSel([n.id]);
        const multi = selection.size > 1;
        startDrag(me);
        if (drag && multi) drag.collapseTo = n.id; // un simple clic (sans déplacement) réduira la sélection à cette boîte
      });
      g.append(head, mk('text', { class: 'gtitle', x: n.x + 24, y: n.y + 18, 'data-full': n.name, 'data-max': NODE_W - 24 - (n.kind === 'plugin' ? 72 : 30) }, n.name));
      // point de couleur : ouvre la palette de cette boîte (anneau vide = couleur par défaut)
      const colorDot = mk('circle', { class: 'gcolor', cx: n.x + 13, cy: n.y + 14, r: 6.5, ...(n.color ? { style: `fill:${n.color};stroke:#10151a` } : {}) });
      colorDot.append(mk('title', {}, 'Choisir la couleur de cette boîte'));
      colorDot.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); swallowClick = false; });
      colorDot.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onColor?.(n.id, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY); });
      g.append(colorDot);
      const del = mk('text', { class: 'gbtn gdel', x: n.x + NODE_W - 16, y: n.y + 18 }, '×');
      del.addEventListener('click', (ev) => { ev.stopPropagation(); removeNode(p, n.id); render(); opts.onChange(); opts.onMessage(`« ${n.name} » supprimé.`, 'ok'); });
      g.append(del);
      if (n.kind === 'plugin') {
        const byp = mk('text', { class: 'gbtn gbyp', x: n.x + NODE_W - 38, y: n.y + 18 }, '⏻');
        byp.addEventListener('click', (ev) => { ev.stopPropagation(); n.bypass = !n.bypass; render(); opts.onChange(); opts.onMessage(`« ${n.name} » ${n.bypass ? 'contourné' : 'actif'}.`, 'info'); });
        const rep = mk('text', { class: 'gbtn grep', x: n.x + NODE_W - 60, y: n.y + 18 }, '⇄');
        rep.addEventListener('click', (ev) => { ev.stopPropagation(); opts.onReplace?.(n.id); });
        g.append(byp, rep);
      }
      if (n.preset) g.append(mk('text', { class: 'gpreset', x: n.x + 8, y: n.y + h - 7 }, `♪ ${n.preset.name.length > 30 ? n.preset.name.slice(0, 29) + '…' : n.preset.name}${n.preset.kind === 'state' || n.preset.applied ? ' (appliqué)' : ''}`));
      const addPort = (name: string, i: number, side: 'in' | 'out', type: string): void => {
        const cx = side === 'in' ? n.x : n.x + NODE_W; const cy = portY(n, i);
        const isPending = pending?.node === n.id && pending.port === name;
        const dot = mk('circle', { class: `port ${type}${isPending ? ' pend' : ''}`, cx, cy, r: 6, 'data-node': n.id, 'data-port': name, 'data-side': side });
        const label = mk('text', { class: side === 'out' ? 'gport end' : 'gport', x: side === 'in' ? n.x + 10 : n.x + NODE_W - 10, y: cy + 4 }, name);
        label.setAttribute('data-node', n.id); label.setAttribute('data-port', name); label.setAttribute('data-side', side);
        // zone de saisie invisible sur toute la ligne du port : bien plus facile à viser que le petit rond
        const hit = mk('rect', { class: 'porthit', x: side === 'in' ? n.x - 12 : n.x + NODE_W - 110, y: cy - ROW_H / 2, width: 122, height: ROW_H, 'data-node': n.id, 'data-port': name, 'data-side': side });
        g.append(hit);
        for (const el of [hit, dot, label]) {
          el.addEventListener('click', (ev) => { ev.stopPropagation(); clickPort(p, { node: n.id, port: name }); });
          el.addEventListener('mousedown', (ev) => {
            const me = ev as MouseEvent;
            if (me.button !== 0) return;
            ev.preventDefault(); ev.stopPropagation(); swallowClick = false;
            startLink(me, { node: n.id, port: name });
          });
        }
        g.append(dot, label);
      };
      ports.inputs.forEach((pt, i) => addPort(pt.name, i, 'in', pt.type));
      ports.outputs.forEach((pt, i) => addPort(pt.name, i, 'out', pt.type));
      items.push(g);
    }
    svg.replaceChildren(...items);
    fitTitles();
    if (p.nodes.length === 0) svg.append(mk('text', { class: 'gport', x: 24, y: 40 }, 'Patchbay vide : demandez une chaîne à l\'Assistant, ou ajoutez des plugins avec la barre d\'outils.'));
  }

  svg.addEventListener('mousedown', (ev) => {
    const me = ev as MouseEvent;
    if (me.target !== svg || me.button !== 0) return;
    swallowClick = false;
    const pt = toSvg(me);
    rubber = { x0: pt.x, y0: pt.y, moved: false, el: null, additive: me.shiftKey || me.ctrlKey || me.metaKey };
  });

  svg.addEventListener('mousemove', (ev) => {
    const me = ev as MouseEvent;
    const p = get();
    if (drag) {
      const dx = (me.clientX - drag.sx) / zoom, dy = (me.clientY - drag.sy) / zoom;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      for (const n of p.nodes) { const s = drag.starts.get(n.id); if (s) { n.x = Math.max(0, s.x + dx); n.y = Math.max(0, s.y + dy); } }
      render();
    } else if (link) {
      if (!link.moved && Math.hypot(me.clientX - link.sx, me.clientY - link.sy) < 4) return;
      link.moved = true;
      const start = [...svg.querySelectorAll('circle.port')].find((c) => c.getAttribute('data-node') === link?.from.node && c.getAttribute('data-port') === link?.from.port);
      const pt = toSvg(me);
      const target = snapTarget(pt);
      if (target?.el !== link.snap?.el) { link.snap?.el.classList.remove('snap'); target?.el.classList.add('snap'); }
      link.snap = target;
      // fil souple (courbe de Bézier comme les vrais câbles) : il suit la souris, ou se colle au port aimanté
      const x1 = Number(start?.getAttribute('cx') ?? 0), y1 = Number(start?.getAttribute('cy') ?? 0);
      const x2 = target ? target.x : pt.x, y2 = target ? target.y : pt.y;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (link.side === 'in' ? -1 : 1);
      if (!link.line) { link.line = mk('path', { class: 'templink' }); svg.append(link.line); }
      link.line.setAttribute('stroke', colorOf(get(), link.from.node));
      link.line.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
    } else if (rubber) {
      const pt = toSvg(me);
      if (!rubber.moved && Math.hypot(pt.x - rubber.x0, pt.y - rubber.y0) < 4) return;
      rubber.moved = true;
      if (!rubber.el) { rubber.el = mk('rect', { class: 'rubber' }); svg.append(rubber.el); }
      rubber.el.setAttribute('x', String(Math.min(rubber.x0, pt.x))); rubber.el.setAttribute('y', String(Math.min(rubber.y0, pt.y)));
      rubber.el.setAttribute('width', String(Math.abs(pt.x - rubber.x0))); rubber.el.setAttribute('height', String(Math.abs(pt.y - rubber.y0)));
    }
  });

  svg.addEventListener('mouseup', (ev) => {
    const me = ev as MouseEvent;
    const p = get();
    if (drag) {
      const d = drag; drag = null;
      if (d.moved) {
        if (opts.snap?.()) snapNodes(p, [...d.starts.keys()], 20);
        swallowClick = true; render(); opts.onChange();
      } else if (d.collapseTo) setSel([d.collapseTo]);
    } else if (link) {
      const l = link; link = null;
      if (!l.moved) { svg.querySelectorAll('circle.dim').forEach((c) => c.classList.remove('dim')); return; } // simple clic : mode clic-clic
      const t = me.target as Element;
      const tn = l.snap ? l.snap.node : t.getAttribute?.('data-node'); const tp = l.snap ? l.snap.port : t.getAttribute?.('data-port');
      swallowClick = true;
      if (tn && tp && !(tn === l.from.node && tp === l.from.port)) {
        const err = connect(p, l.from, { node: tn, port: tp });
        if (err) opts.onMessage(err, 'err'); else opts.onMessage('Câble créé.', 'ok');
        render(); if (!err) opts.onChange();
      } else render();
    } else if (rubber) {
      const r = rubber; rubber = null;
      if (r.moved) {
        const pt = toSvg(me);
        const x0 = Math.min(r.x0, pt.x), x1 = Math.max(r.x0, pt.x), y0 = Math.min(r.y0, pt.y), y1 = Math.max(r.y0, pt.y);
        const hit = p.nodes.filter((n) => n.x < x1 && n.x + NODE_W > x0 && n.y < y1 && n.y + nodeHeight(n, p.hardware) > y0).map((n) => n.id);
        swallowClick = true;
        setSel(r.additive ? [...new Set([...selection, ...hit])] : hit);
      }
    }
  });

  svg.addEventListener('click', (ev) => {
    if (swallowClick) { swallowClick = false; return; }
    if (ev.target !== svg) return;
    if (pending || selectedCable !== null || selection.size) { pending = null; selectedCable = null; if (selection.size) { selection = new Set(); notifySelect(); } render(); }
  });

  // relâcher la souris en dehors du dessin annule le geste en cours
  document.addEventListener('mouseup', (ev) => {
    if (svg.contains(ev.target as Node)) return;
    if (link || drag || rubber) { link = null; drag = null; rubber = null; render(); }
  });

  host.addEventListener('wheel', (ev) => {
    if (!(ev as WheelEvent).ctrlKey) return;
    ev.preventDefault();
    setZoom(zoom * ((ev as WheelEvent).deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  document.addEventListener('keydown', (ev) => {
    if (!svg.isConnected || host.closest('section')?.hidden) return;
    const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLSelectElement;
    if (ev.key === 'Escape') { if (pending) { pending = null; render(); } else if (selection.size) setSel([]); return; }
    if (typing) return;
    const p = get();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); setSel(p.nodes.map((n) => n.id)); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selectedCable !== null) { disconnect(p, selectedCable); selectedCable = null; render(); opts.onChange(); opts.onMessage('Câble supprimé.', 'ok'); }
      else if (selection.size) {
        const n = selection.size;
        for (const id of [...selection]) removeNode(p, id);
        selection = new Set(); notifySelect(); render(); opts.onChange(); opts.onMessage(`${n} boîte(s) supprimée(s) (Ctrl+Z pour annuler).`, 'ok');
      }
    }
  });

  function setZoom(z: number): void { zoom = Math.min(1.6, Math.max(0.4, Math.round(z * 100) / 100)); render(); }

  render();
  return {
    render,
    getSelection: () => [...selection],
    setSelection: setSel,
    getZoom: () => zoom,
    setZoom,
    center() {
      const bb = boundingBox(get());
      if (!bb) return;
      host.scrollLeft = Math.max(0, (bb.x + bb.w / 2) * zoom - host.clientWidth / 2);
      host.scrollTop = Math.max(0, (bb.y + bb.h / 2) * zoom - host.clientHeight / 2);
    },
  };
}
