// src/lib/inflate.ts : décompression « deflate » (RFC 1951) / zlib (RFC 1950) en TypeScript pur, sans dépendance.
// Sert à lire l'état de certains plugins (ex. MeldaProduction) qui le compressent. Adapté de l'algorithme de référence « puff ».

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_OUT = 256 * 1024 * 1024; // garde-fou : un fichier malveillant ne doit pas saturer la mémoire

interface Huffman { count: Uint16Array; symbol: Uint16Array }

function construct(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i] ?? 0] = (count[lengths[i] ?? 0] ?? 0) + 1;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left <<= 1;
    left -= count[len] ?? 0;
    if (left < 0) throw new Error('Données compressées invalides (codes de Huffman sur-souscrits).');
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = (offs[len] ?? 0) + (count[len] ?? 0);
  for (let s = 0; s < n; s++) {
    const l = lengths[s] ?? 0;
    if (l !== 0) { symbol[offs[l] ?? 0] = s; offs[l] = (offs[l] ?? 0) + 1; }
  }
  return { count, symbol };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;
function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedLit = construct(l, 288);
    fixedDist = construct(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

/** Décompresse un flux « deflate » brut commençant à `start`. Les octets qui suivent la fin du flux sont ignorés. */
export function inflate(data: Uint8Array, start = 0): Uint8Array {
  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;
  let out = new Uint8Array(Math.max(1024, Math.min(data.length * 4, 1 << 24)));
  let outLen = 0;

  const bits = (need: number): number => {
    while (bitcnt < need) {
      if (pos >= data.length) throw new Error('Données compressées tronquées.');
      bitbuf |= (data[pos++] ?? 0) << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << need) - 1);
    bitbuf >>>= need;
    bitcnt -= need;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const cnt = h.count[len] ?? 0;
      if (code - cnt < first) return h.symbol[index + (code - first)] ?? 0;
      index += cnt; first += cnt; first <<= 1; code <<= 1;
    }
    throw new Error('Données compressées invalides (code inconnu).');
  };
  const ensure = (extra: number): void => {
    if (outLen + extra <= out.length) return;
    if (outLen + extra > MAX_OUT) throw new Error('Données décompressées trop volumineuses.');
    const bigger = new Uint8Array(Math.min(MAX_OUT, Math.max(out.length * 2, outLen + extra)));
    bigger.set(out.subarray(0, outLen));
    out = bigger;
  };
  const codes = (lit: Huffman, dist: Huffman): void => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) { ensure(1); out[outLen++] = sym; continue; }
      if (sym === 256) return;
      sym -= 257;
      if (sym >= 29) throw new Error('Données compressées invalides (longueur).');
      const len = (LBASE[sym] ?? 0) + bits(LEXT[sym] ?? 0);
      const ds = decode(dist);
      if (ds >= 30) throw new Error('Données compressées invalides (distance).');
      const d = (DBASE[ds] ?? 0) + bits(DEXT[ds] ?? 0);
      if (d > outLen) throw new Error('Données compressées invalides (distance trop grande).');
      ensure(len);
      for (let i = 0; i < len; i++) { out[outLen] = out[outLen - d] ?? 0; outLen++; }
    }
  };

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      if (pos + 4 > data.length) throw new Error('Données compressées tronquées.');
      const len = (data[pos] ?? 0) | ((data[pos + 1] ?? 0) << 8);
      const nlen = (data[pos + 2] ?? 0) | ((data[pos + 3] ?? 0) << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('Données compressées invalides (bloc brut).');
      pos += 4;
      if (pos + len > data.length) throw new Error('Données compressées tronquées.');
      ensure(len);
      out.set(data.subarray(pos, pos + len), outLen);
      outLen += len; pos += len;
    } else if (type === 1) {
      const [l, d] = fixedTables();
      codes(l, d);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new Error('Données compressées invalides (tables).');
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[ORDER[i] ?? 0] = bits(3);
      const lencode = construct(lengths.subarray(0, 19), 19);
      lengths.fill(0);
      let idx = 0;
      while (idx < nlen + ndist) {
        const sym = decode(lencode);
        if (sym < 16) { lengths[idx++] = sym; continue; }
        let len = 0, rep: number;
        if (sym === 16) { if (idx === 0) throw new Error('Données compressées invalides (répétition).'); len = lengths[idx - 1] ?? 0; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (idx + rep > nlen + ndist) throw new Error('Données compressées invalides (tables).');
        while (rep--) lengths[idx++] = len;
      }
      codes(construct(lengths.subarray(0, nlen), nlen), construct(lengths.subarray(nlen, nlen + ndist), ndist));
    } else {
      throw new Error('Données compressées invalides (type de bloc).');
    }
  } while (!last);
  return out.slice(0, outLen);
}

/** Décompresse un flux zlib (en-tête de 2 octets + deflate). Lève une erreur si l'en-tête n'est pas valide. */
export function zlibInflate(data: Uint8Array): Uint8Array {
  const cmf = data[0] ?? 0, flg = data[1] ?? 0;
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) throw new Error("En-tête zlib invalide.");
  return inflate(data, 2);
}
