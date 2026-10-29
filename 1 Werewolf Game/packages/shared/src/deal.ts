import { ROLES, type RoleId } from './roles';

/**
 * A custom game's deal (owner request, 2026-10-26): the host seats the players and deals the
 * cards. Pure helpers, shared by the server and the web lobby (no zod: the browser bundle stays
 * small). The schema that checks the shape is `ManualDealSchema` in protocol.ts.
 */
export interface Deal {
  /** `roles[i]` is the card of slot i + 1, which sits at seat i + 1. */
  roles: RoleId[];
  /** With a Thief: the two cards left in the middle. */
  extras?: RoleId[];
}

/** A wolf of the pack: wolf nature, but not the White Werewolf, who plays for himself (ruleset §6 step 2.2). */
const isPackWolf = (r: RoleId) => ROLES[r].wolfNature && r !== 'white_werewolf';
const label = (r: string) => ROLES[r as RoleId]?.label ?? r;

/**
 * The deal as it starts: the mode's cards in their listed order. With a Thief, the cards that must
 * be in play (the Thief, the Sisters, one pack wolf) come first, so the two left in the middle never
 * break the §6 rules below.
 */
export function manualDealFrom(cards: readonly string[], seats: number): Deal {
  let order = [...cards] as RoleId[];
  if (order.length > seats) {
    const must: RoleId[] = [];
    const take = (pred: (r: RoleId) => boolean): boolean => {
      const i = order.findIndex(pred);
      if (i >= 0) must.push(order.splice(i, 1)[0]!);
      return i >= 0;
    };
    take((r) => r === 'thief');
    while (order.includes('two_sisters')) take((r) => r === 'two_sisters');
    if (!take(isPackWolf)) take((r) => ROLES[r].wolfNature);
    order = [...must, ...order];
  }
  const roles = order.slice(0, seats);
  const extras = order.slice(seats);
  return extras.length ? { roles, extras } : { roles };
}

/**
 * Why a host's deal cannot be played with this mode, or null when it can: one card per seat, the
 * Thief's two extras when the mode has them, and together exactly the mode's cards. As in the
 * random deal (ruleset §6), the Thief, both Sisters and a pack wolf (not only the White Werewolf)
 * are always in play.
 */
export function manualDealProblem(cards: readonly string[], seats: number, deal: Deal): string | null {
  if (deal.roles.length !== seats) return `the mode has ${seats} seats, but ${deal.roles.length} were given a card`;
  const extras = deal.extras ?? [];
  if (extras.length !== cards.length - seats) {
    return cards.length > seats ? 'with a Thief, exactly two cards stay in the middle' : 'this mode has no cards left in the middle';
  }
  const count = (list: readonly string[]) => list.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>());
  const want = count(cards);
  const got = count([...deal.roles, ...extras]);
  for (const [c, n] of got) if ((want.get(c) ?? 0) < n) return `the mode has ${want.get(c) ?? 0} ${label(c)} card(s), but ${n} were dealt`;
  for (const [c, n] of want) if ((got.get(c) ?? 0) < n) return `the mode's ${label(c)} card was not dealt to anyone`;
  if (extras.includes('thief')) return 'the Thief must sit at a seat, not in the middle';
  if (extras.includes('two_sisters')) return 'both Sisters must sit at seats, not in the middle';
  if (extras.length) {
    const packInDeck = (cards as RoleId[]).some(isPackWolf);
    if (packInDeck ? !deal.roles.some(isPackWolf) : !deal.roles.some((r) => ROLES[r].wolfNature)) {
      if (!packInDeck) return 'at least one wolf must sit at a seat';
      return cards.includes('white_werewolf') ? 'at least one wolf of the pack (not only the White Werewolf) must sit at a seat' : 'at least one Werewolf must sit at a seat';
    }
  }
  return null;
}

/**
 * Give the card at `pos` (seats first, then the extras) the role `role`, swapping with the first
 * other place that holds it: the deal stays exactly the mode's cards after every change.
 */
export function assignRole(deal: Deal, pos: number, role: RoleId): Deal {
  const all = [...deal.roles, ...(deal.extras ?? [])];
  if (pos < 0 || pos >= all.length || all[pos] === role) return deal;
  const other = all.findIndex((r, i) => i !== pos && r === role);
  if (other < 0) return deal; // not one of the mode's cards: nothing to swap with
  [all[pos], all[other]] = [all[other]!, all[pos]!];
  const n = deal.roles.length;
  return deal.extras ? { roles: all.slice(0, n), extras: all.slice(n) } : { roles: all };
}

/**
 * Why giving `role` to the place `pos` would make the deal unplayable (null: it is fine), so the
 * lobby can grey that choice out with its reason instead of letting the server refuse it.
 */
export function assignProblem(cards: readonly string[], seats: number, deal: Deal, pos: number, role: RoleId): string | null {
  const next = assignRole(deal, pos, role);
  return next === deal ? null : manualDealProblem(cards, seats, next);
}
