// src/lib/valuetree.ts : lecture et écriture du format binaire des « ValueTree » de JUCE (celui qu'utilise le plugin TONE3000).
//
// Format (JUCE ValueTree::writeToStream) :
//   arbre   = nom du type (UTF-8 terminé par 0) + nbPropriétés + [nom (UTF-8+0) + variante]* + nbEnfants + [arbre]*
//   entier compressé = 1 octet (nombre d'octets suivants, bit 0x80 = négatif) + octets de la valeur (petit-boutiste) ; 0 s'écrit « 00 »
//   variante = entier compressé (taille) puis, si la taille > 0 : 1 octet de type + (taille-1) octets
//   types vérifiés sur de vrais fichiers : 1 entier, 2 vrai, 3 faux, 4 double, 5 chaîne, 6 entier 64 bits, 8 binaire
// Les variantes sont conservées telles quelles (type + octets) : relire puis réécrire redonne les mêmes octets.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

export interface VtProp { name: string; marker: number; payload: Uint8Array } // marker -1 = variante vide
export interface VtTree { type: string; props: VtProp[]; children: VtTree[] }

export const MARK = { int: 1, bTrue: 2, bFalse: 3, double: 4, string: 5, int64: 6, binary: 8 } as const;

class Reader {
  constructor(readonly d: Uint8Array, public p = 0) {}
  byte(): number { if (this.p >= this.d.length) throw new Error('Arbre binaire tronqué.'); return this.d[this.p++] as number; }
  cint(): number {
    const first = this.byte();
    const n = first & 0x7f;
    if (n > 4) throw new Error('Arbre binaire invalide (entier).');
    let v = 0;
    for (let i = 0; i < n; i++) v += this.byte() * 2 ** (8 * i);
    return first & 0x80 ? -v : v;
  }
  str(): string {
    const e = this.d.indexOf(0, this.p);
    if (e < 0) throw new Error('Arbre binaire tronqué (chaîne).');
    const s = dec.decode(this.d.subarray(this.p, e));
    this.p = e + 1;
    return s;
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.p + n > this.d.length) throw new Error('Arbre binaire tronqué (données).');
    const out = this.d.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
}

function readTree(r: Reader, depth = 0): VtTree {
  if (depth > 64) throw new Error('Arbre binaire trop profond.');
  const type = r.str();
  const nProps = r.cint();
  if (nProps < 0 || nProps > 100_000) throw new Error('Arbre binaire invalide (propriétés).');
  const props: VtProp[] = [];
  for (let i = 0; i < nProps; i++) {
    const name = r.str();
    const size = r.cint();
    if (size <= 0) { props.push({ name, marker: -1, payload: new Uint8Array(0) }); continue; }
    const marker = r.byte();
    props.push({ name, marker, payload: r.take(size - 1) });
  }
  const nKids = r.cint();
  if (nKids < 0 || nKids > 1_000_000) throw new Error('Arbre binaire invalide (enfants).');
  const children: VtTree[] = [];
  for (let i = 0; i < nKids; i++) children.push(readTree(r, depth + 1));
  return { type, props, children };
}

/** Lit un arbre à partir de `start`. Renvoie l'arbre et la position juste après lui. */
export function readValueTree(data: Uint8Array, start = 0): { tree: VtTree; end: number } {
  const r = new Reader(data, start);
  const tree = readTree(r);
  return { tree, end: r.p };
}

function cintBytes(v: number): number[] {
  if (v === 0) return [0];
  const neg = v < 0;
  let u = Math.abs(v);
  const bytes: number[] = [];
  while (u > 0) { bytes.push(u % 256); u = Math.floor(u / 256); }
  return [bytes.length | (neg ? 0x80 : 0), ...bytes];
}

function writeTree(t: VtTree, out: Uint8Array[]): void {
  out.push(enc.encode(t.type), new Uint8Array([0]), new Uint8Array(cintBytes(t.props.length)));
  for (const p of t.props) {
    out.push(enc.encode(p.name), new Uint8Array([0]));
    if (p.marker < 0) out.push(new Uint8Array([0]));
    else out.push(new Uint8Array([...cintBytes(p.payload.length + 1), p.marker]), p.payload);
  }
  out.push(new Uint8Array(cintBytes(t.children.length)));
  for (const c of t.children) writeTree(c, out);
}

export function writeValueTree(t: VtTree): Uint8Array {
  const parts: Uint8Array[] = [];
  writeTree(t, parts);
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ----- accès pratiques aux propriétés
export const strProp = (name: string, v: string): VtProp => ({ name, marker: MARK.string, payload: enc.encode(v + '\0') });
export const doubleProp = (name: string, v: number): VtProp => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return { name, marker: MARK.double, payload: b }; };

export function getStr(t: VtTree, name: string): string | undefined {
  const p = t.props.find((x) => x.name === name);
  return p && p.marker === MARK.string ? dec.decode(p.payload).replace(/\0+$/, '') : undefined;
}
export function getDouble(t: VtTree, name: string): number | undefined {
  const p = t.props.find((x) => x.name === name);
  return p && p.marker === MARK.double && p.payload.length === 8 ? new DataView(p.payload.buffer, p.payload.byteOffset, 8).getFloat64(0, true) : undefined;
}
export function getInt(t: VtTree, name: string): number | undefined {
  const p = t.props.find((x) => x.name === name);
  return p && p.marker === MARK.int && p.payload.length === 4 ? new DataView(p.payload.buffer, p.payload.byteOffset, 4).getInt32(0, true) : undefined;
}
export function setProp(t: VtTree, prop: VtProp): void {
  const i = t.props.findIndex((x) => x.name === prop.name);
  if (i >= 0) t.props[i] = prop; else t.props.push(prop);
}
