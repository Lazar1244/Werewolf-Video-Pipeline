import { describe, expect, it } from 'vitest';
import { chance, cloneRng, createRng, nextFloat, nextInt, nextU32, pick, shuffle } from '../src/rng';

describe('rng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng('game-42');
    const b = createRng('game-42');
    const sa = Array.from({ length: 50 }, () => nextU32(a));
    const sb = Array.from({ length: 50 }, () => nextU32(b));
    expect(sa).toEqual(sb);
  });

  it('differs for different seeds', () => {
    const a = createRng('seed-a');
    const b = createRng('seed-b');
    expect(Array.from({ length: 8 }, () => nextU32(a))).not.toEqual(Array.from({ length: 8 }, () => nextU32(b)));
  });

  it('matches the golden sequence (changing this breaks replays: bump ENGINE_VERSION)', () => {
    const r = createRng('wearwolfe');
    expect(Array.from({ length: 6 }, () => nextU32(r))).toEqual(GOLDEN);
  });

  it('matches the reference xoshiro128** vector for state [1,2,3,4]', () => {
    const r = { s: [1, 2, 3, 4] as [number, number, number, number] };
    expect(Array.from({ length: 6 }, () => nextU32(r))).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492]);
  });

  it('resumes exactly from a serialised state', () => {
    const r = createRng('resume');
    for (let i = 0; i < 100; i++) nextU32(r);
    const saved = JSON.parse(JSON.stringify(r));
    const expected = Array.from({ length: 20 }, () => nextU32(r));
    expect(Array.from({ length: 20 }, () => nextU32(saved))).toEqual(expected);
  });

  it('cloneRng is independent', () => {
    const r = createRng('clone');
    const c = cloneRng(r);
    nextU32(r);
    expect(c.s).not.toEqual(r.s);
  });

  it('nextFloat stays in [0,1)', () => {
    const r = createRng('float');
    for (let i = 0; i < 10_000; i++) {
      const f = nextFloat(r);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('nextInt is in range and roughly uniform', () => {
    const r = createRng('uniform');
    const n = 7;
    const counts = new Array(n).fill(0);
    const draws = 70_000;
    for (let i = 0; i < draws; i++) counts[nextInt(r, n)]++;
    for (const c of counts) expect(Math.abs(c - draws / n)).toBeLessThan((draws / n) * 0.05);
  });

  it('nextInt rejects invalid bounds', () => {
    const r = createRng('x');
    expect(() => nextInt(r, 0)).toThrow();
    expect(() => nextInt(r, 2.5)).toThrow();
  });

  it('chance rejects non-finite probabilities without consuming a draw', () => {
    const r = createRng('nan');
    const before = cloneRng(r);
    expect(() => chance(r, Number.NaN)).toThrow(RangeError);
    expect(() => chance(r, Infinity)).toThrow(RangeError);
    expect(r.s).toEqual(before.s);
  });

  it('chance handles edges', () => {
    const r = createRng('chance');
    expect(chance(r, 0)).toBe(false);
    expect(chance(r, 1)).toBe(true);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (chance(r, 0.2)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.18);
    expect(hits / 20_000).toBeLessThan(0.22);
  });

  it('shuffle returns a permutation and does not mutate input', () => {
    const r = createRng('shuffle');
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = shuffle(r, input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it('pick throws on empty arrays', () => {
    expect(() => pick(createRng('p'), [])).toThrow();
  });
});

// Captured from the first implementation run (xoshiro128** + cyrb128 seeding + 16 warm-up draws).
const GOLDEN: number[] = [102109502, 2665438408, 3561284279, 3058795441, 1404225971, 2482655677];
