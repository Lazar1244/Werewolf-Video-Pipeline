import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RulesOverrideSchema, RulesSchema, layerRules, resolveSentinels } from '../src';

const defaults = RulesSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../config/rules/default.json'), 'utf8')),
);

describe('rules layering', () => {
  it('shipped defaults match the owner decisions (ruleset §18)', () => {
    expect(defaults.seer_mode).toBe('alignment');
    expect(defaults.reveal_on_death).toBe('full');
    expect(defaults.angel_ends_game).toBe(true);
    expect(defaults.debrief_enabled).toBe('ask');
  });

  it('later layers override earlier ones, nested objects merge', () => {
    const out = layerRules(defaults, { discussion_rounds: 3, words: { speech: 90 } }, { words: { rebuttal: 40 } });
    expect(out.discussion_rounds).toBe(3);
    expect(out.words.speech).toBe(90);
    expect(out.words.rebuttal).toBe(40);
    expect(out.words.last_words).toBe(defaults.words.last_words);
  });

  it('does not mutate the base object', () => {
    const before = JSON.stringify(defaults);
    layerRules(defaults, { discussion_rounds: 4 });
    expect(JSON.stringify(defaults)).toBe(before);
  });

  it('resolves sentinels from the seat count', () => {
    expect(resolveSentinels(defaults, 6)).toMatchObject({ sheriff_enabled: false, max_days: 6 });
    expect(resolveSentinels(defaults, 7)).toMatchObject({ sheriff_enabled: true, max_days: 7 });
    expect(resolveSentinels({ ...defaults, sheriff_enabled: true, max_days: 12 }, 5)).toMatchObject({
      sheriff_enabled: true,
      max_days: 12,
    });
  });

  it('rejects unknown keys (typo protection), also in overrides', () => {
    expect(RulesSchema.safeParse({ ...defaults, discusion_rounds: 2 }).success).toBe(false);
    expect(RulesOverrideSchema.safeParse({ discusion_rounds: 2 }).success).toBe(false);
    expect(RulesOverrideSchema.safeParse({ words: { speach: 10 } }).success).toBe(false);
    expect(RulesOverrideSchema.safeParse({ words: { speech: 90 } }).success).toBe(true);
  });
});
