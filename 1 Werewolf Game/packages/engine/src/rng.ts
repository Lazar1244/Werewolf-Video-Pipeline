/**
 * Deterministic, serialisable RNG: xoshiro128** seeded from a string.
 *
 * The state is a plain object stored inside the engine state, so a saved game
 * resumes with exactly the same random sequence (ARCHITECTURE.md §5.1).
 * All functions mutate the given state object in place.
 */

export interface RngState {
  s: [number, number, number, number];
}

/** cyrb128 string hash → four 32-bit words. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRng(seed: string): RngState {
  const s = cyrb128(seed);
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1; // all-zero state is invalid for xoshiro
  const state: RngState = { s };
  // Warm up to decorrelate similar seeds.
  for (let i = 0; i < 16; i++) nextU32(state);
  return state;
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** Next uniformly distributed unsigned 32-bit integer. */
export function nextU32(state: RngState): number {
  const s = state.s;
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result;
}

/** Float in [0, 1). */
export function nextFloat(state: RngState): number {
  return nextU32(state) / 4294967296;
}

/** Unbiased integer in [0, n). */
export function nextInt(state: RngState, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 4294967296) throw new RangeError(`nextInt: invalid bound ${n}`);
  const limit = 4294967296 - (4294967296 % n);
  let x: number;
  do x = nextU32(state);
  while (x >= limit);
  return x % n;
}

/** True with probability p. */
export function chance(state: RngState, p: number): boolean {
  if (!Number.isFinite(p)) throw new RangeError(`chance: probability must be finite (got ${p})`);
  if (p <= 0) return false;
  if (p >= 1) return true;
  return nextFloat(state) < p;
}

export function pick<T>(state: RngState, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick: empty array');
  return items[nextInt(state, items.length)] as T;
}

/** Fisher–Yates shuffle; returns a new array. */
export function shuffle<T>(state: RngState, items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(state, i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

export function cloneRng(state: RngState): RngState {
  return { s: [...state.s] as RngState['s'] };
}
