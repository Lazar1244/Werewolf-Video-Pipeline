import { z } from 'zod';
import { ROLE_IDS, ROLES, type RoleId } from '../roles';
import { RulesOverrideSchema } from './rules';

/** Where a game mode comes from: the ruleset's classic tables, our recommendations, or the host. */
export const COMPOSITION_CATEGORIES = ['classic', 'recommended', 'custom'] as const;
export type CompositionCategory = (typeof COMPOSITION_CATEGORIES)[number];

/** `config/compositions/*.json` — game modes (role presets, ruleset §12). */
export const CompositionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  label: z.string().min(1).max(40),
  /** Missing means a mode the host made (the gallery shows it under "Your modes"). */
  category: z.enum(COMPOSITION_CATEGORIES).optional(),
  seats: z.int().min(5).max(10),
  cards: z.array(z.enum(ROLE_IDS)).min(5),
  /** One or two sentences a host reads in the gallery: what makes this table play differently. */
  description: z.string().min(1).max(400).optional(),
  /** Short labels for the gallery, e.g. "beginner", "information", "solo". */
  tags: z.array(z.string().min(1).max(20)).max(4).optional(),
  ruleOverrides: RulesOverrideSchema.optional(),
  notes: z.string().optional(),
});

export type Composition = z.infer<typeof CompositionSchema>;

export interface CompositionReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Sum of all card weights (with a Thief: all N+2 deck cards). */
  weight: number;
  /**
   * With a Thief only: the possible weight of the N cards actually in play,
   * over every legal pair of set-aside cards (never a Sister card, and at least
   * one wolf-nature card stays in play). The balance warning uses this range.
   */
  weightRange?: { min: number; max: number };
}

export const BALANCE_BAND = { min: -3, max: 5 } as const;

const WOLF_NATURE_CARDS: readonly RoleId[] = ROLE_IDS.filter((id) => ROLES[id].wolfNature);

/**
 * Hard validation (ruleset §12.1) and soft balance check (§12.2).
 * `revealOnDeath` is the resolved rule value (needed for the Bear Tamer rule).
 */
export function validateComposition(
  comp: Pick<Composition, 'seats' | 'cards'>,
  revealOnDeath: 'full' | 'team' | 'none' = 'full',
): CompositionReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const n = comp.seats;
  const counts = new Map<RoleId, number>();
  for (const c of comp.cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  const count = (id: RoleId) => counts.get(id) ?? 0;

  if (n < 5 || n > 10) errors.push(`seats must be 5..10 (got ${n})`);

  const hasThief = count('thief') > 0;
  const expectedCards = hasThief ? n + 2 : n;
  if (comp.cards.length !== expectedCards) {
    errors.push(
      `card count must be ${expectedCards} (${n} seats${hasThief ? ' + 2 Thief extras' : ''}), got ${comp.cards.length}`,
    );
  }

  const wolfCards = comp.cards.filter((c) => WOLF_NATURE_CARDS.includes(c)).length;
  const minWolves = Math.max(1, Math.floor(n / 5));
  const maxWolves = Math.ceil(n / 3);
  if (wolfCards < minWolves || wolfCards > maxWolves) {
    errors.push(`wolf-nature cards must be between ${minWolves} and ${maxWolves} for ${n} seats (got ${wolfCards})`);
  }

  if (count('white_werewolf') > 0 && wolfCards - count('white_werewolf') < 1) {
    errors.push('White Werewolf requires at least one other wolf-nature card');
  }

  for (const [id, k] of counts) {
    const meta = ROLES[id];
    if (id === 'two_sisters') {
      if (k !== 2) errors.push(`Two Sisters must appear exactly 2 times or not at all (got ${k})`);
    } else if (meta.unique && k > 1) {
      errors.push(`${meta.label} is unique but appears ${k} times`);
    }
  }

  const soloCards = comp.cards.filter((c) => ROLES[c].countsAsSolo).length;
  const soloMax = n <= 8 ? 2 : 3;
  if (soloCards > soloMax) errors.push(`at most ${soloMax} solo/ambiguous cards for ${n} seats (got ${soloCards})`);

  if (count('bear_tamer') > 0 && revealOnDeath !== 'full') {
    errors.push('Bear Tamer requires reveal_on_death = "full"');
  }

  const weight = comp.cards.reduce((sum, c) => sum + ROLES[c].weight, 0);
  const band = `${BALANCE_BAND.min}..${BALANCE_BAND.max}`;

  if (hasThief) {
    const range = thiefWeightRange(comp.cards, weight);
    if (range && (range.max < BALANCE_BAND.min || range.min > BALANCE_BAND.max)) {
      warnings.push(`balance weight in play (${range.min}..${range.max}) is entirely outside the recommended band ${band}`);
    }
    return { ok: errors.length === 0, errors, warnings, weight, ...(range ? { weightRange: range } : {}) };
  }

  if (weight < BALANCE_BAND.min || weight > BALANCE_BAND.max) {
    warnings.push(`balance weight ${weight} is outside the recommended band ${band}`);
  }
  return { ok: errors.length === 0, errors, warnings, weight };
}

/**
 * Ruleset §6 constructive deal: the Thief card and Sister cards are always dealt,
 * and one team-Werewolf card (wolf nature, not the White Werewolf) always stays in play.
 * Every other pair of cards can be the two extras.
 */
function thiefWeightRange(cards: readonly RoleId[], total: number): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  const isPackWolf = (c: RoleId) => WOLF_NATURE_CARDS.includes(c) && c !== 'white_werewolf';
  const packWolves = cards.filter(isPackWolf).length;
  const alwaysDealt = (c: RoleId) => c === 'thief' || c === 'two_sisters';
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]!;
      const b = cards[j]!;
      if (alwaysDealt(a) || alwaysDealt(b)) continue;
      const removedWolves = Number(isPackWolf(a)) + Number(isPackWolf(b));
      if (packWolves - removedWolves < 1) continue;
      const w = total - ROLES[a].weight - ROLES[b].weight;
      if (w < min) min = w;
      if (w > max) max = w;
    }
  }
  return Number.isFinite(min) ? { min, max } : undefined;
}
