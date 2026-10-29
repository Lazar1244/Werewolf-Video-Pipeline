import type { ResolvedRules, Rules, RulesOverride } from './rules';

/**
 * Config layering (ARCHITECTURE.md §8):
 *   rules/default.json (complete; no separate code-defaults layer) < composition.ruleOverrides < lobby overrides
 * then per-game sentinels ("auto", "N") are resolved once the seat count is known.
 */
export function layerRules(base: Rules, ...overrides: (RulesOverride | undefined)[]): Rules {
  let out: Rules = structuredClone(base);
  for (const o of overrides) {
    if (!o) continue;
    const { words, human_timeouts, ...flat } = o;
    out = {
      ...out,
      ...stripUndefined(flat),
      words: { ...out.words, ...stripUndefined(words ?? {}) },
      human_timeouts: { ...out.human_timeouts, ...stripUndefined(human_timeouts ?? {}) },
    };
  }
  return out;
}

export function resolveSentinels(rules: Rules, seats: number): ResolvedRules {
  return {
    ...rules,
    sheriff_enabled: rules.sheriff_enabled === 'auto' ? seats >= 7 : rules.sheriff_enabled,
    max_days: rules.max_days === 'N' ? seats : rules.max_days,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
