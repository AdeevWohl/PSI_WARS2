/** Seeded, serialisable RNG (sfc32 seeded via xmur3). No Math.random anywhere in the engine. */
export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function seedRng(seed: string): RngState {
  const h = xmur3(seed);
  const r = { a: h(), b: h(), c: h(), d: h() };
  for (let i = 0; i < 12; i++) nextU32(r); // warm up
  return r;
}

export function nextU32(r: RngState): number {
  r.a >>>= 0;
  r.b >>>= 0;
  r.c >>>= 0;
  r.d >>>= 0;
  let t = (r.a + r.b) | 0;
  r.a = r.b ^ (r.b >>> 9);
  r.b = (r.c + (r.c << 3)) | 0;
  r.c = (r.c << 21) | (r.c >>> 11);
  r.d = (r.d + 1) | 0;
  t = (t + r.d) | 0;
  r.c = (r.c + t) | 0;
  return t >>> 0;
}

/** Uniform integer in [0, n) by rejection sampling. */
export function randInt(r: RngState, n: number): number {
  if (n <= 0) throw new Error('randInt: n must be positive');
  const limit = Math.floor(0x100000000 / n) * n;
  let x = nextU32(r);
  while (x >= limit) x = nextU32(r);
  return x % n;
}

export function shuffleInPlace<T>(r: RngState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(r, i + 1);
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}
