import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@ww/config';
import { randomBot, simulate } from '@ww/engine';
import { BALANCE_BAND, checkEngineEvent, layerRules, resolveSentinels, validateComposition, type GameConfig } from '@ww/shared';

/**
 * The game modes the host picks from (ruleset §12). Every shipped mode must be legal (§12.1),
 * sit in the recommended balance band (§12.2), tell the host what it is about, and actually play
 * to an end — a mode that deadlocks the engine must never reach the gallery.
 */
const cfg = loadConfig(join(import.meta.dirname, '../config'));
const modes = [...cfg.compositions.values()];

describe('the shipped game modes', () => {
  it('are all legal, and every one is in the recommended balance band', () => {
    for (const m of modes) {
      const report = validateComposition(m, cfg.rules.reveal_on_death);
      expect(report.errors, m.id).toEqual([]);
      if (report.weightRange) {
        // with a Thief the cards in play vary: the band must at least be reachable
        expect(report.weightRange.min <= BALANCE_BAND.max && report.weightRange.max >= BALANCE_BAND.min, m.id).toBe(true);
      } else {
        expect(report.weight, m.id).toBeGreaterThanOrEqual(BALANCE_BAND.min);
        expect(report.weight, m.id).toBeLessThanOrEqual(BALANCE_BAND.max);
      }
    }
  });

  it('each says what it is about, in the gallery’s words', () => {
    for (const m of modes) {
      expect(m.category, m.id).toMatch(/^(classic|recommended)$/);
      expect(m.description?.length ?? 0, m.id).toBeGreaterThan(30);
      expect(m.tags?.length ?? 0, m.id).toBeGreaterThan(0);
      // there is no popularity data, so nothing may claim it (owner decision)
      expect(`${m.label} ${m.description} ${(m.tags ?? []).join(' ')}`.toLowerCase(), m.id).not.toMatch(/popular|most played|favourite/);
    }
    const labels = modes.map((m) => m.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('offer a choice at every table size from 5 to 10, with a classic and a recommended one', () => {
    for (let n = 5; n <= 10; n++) {
      const here = modes.filter((m) => m.seats === n);
      expect(here.some((m) => m.category === 'classic'), `classic at ${n}`).toBe(true);
      expect(here.some((m) => m.category === 'recommended'), `recommended at ${n}`).toBe(true);
    }
  });

  it('keep the classic tables exactly as the ruleset lists them (§12.3)', () => {
    const cards = (id: string) => [...(cfg.compositions.get(id)?.cards ?? [])].sort();
    const s = (...c: string[]) => c.sort();
    expect(cards('classic-5')).toEqual(s('werewolf', 'seer', 'villager', 'villager', 'villager'));
    expect(cards('classic-6')).toEqual(s('werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'));
    expect(cards('classic-7')).toEqual(s('werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'));
    expect(cards('classic-8')).toEqual(s('werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'cupid', 'villager'));
    expect(cards('classic-9')).toEqual(s('werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'cupid', 'villager', 'villager'));
    expect(cards('classic-10')).toEqual(s('werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'little_girl', 'villager', 'villager'));
    expect(cards('chaos-10')).toEqual(s('werewolf', 'accursed_wolf_father', 'seer', 'witch', 'fox', 'knight', 'elder', 'bear_tamer', 'village_idiot', 'piper'));
  });

  it('every one plays to an end, with valid events, over many deals', () => {
    for (const m of modes) {
      for (let i = 0; i < 12; i++) {
        const seed = `${m.id}-${i}`;
        const game: GameConfig = {
          seed,
          seats: m.seats,
          cards: m.cards,
          rules: resolveSentinels(layerRules(cfg.rules, m.ruleOverrides), m.seats),
          names: cfg.names,
          maskNames: [],
          humanSlots: i % 3 === 0 ? [1] : [],
        };
        const g = simulate(game, randomBot(seed));
        expect(g.result, `${seed} has no result`).toBeTruthy();
        for (const e of g.events) expect(checkEngineEvent(e), `${seed} ${e.type}`).toEqual([]);
      }
    }
  }, 120_000);

  /**
   * A mode is named after an idea: that idea must actually happen in play, and neither main side
   * may be shut out. Random bots are not real players (they vote at random, which favours the
   * wolves), so the bars are low on purpose: they catch a broken or degenerate mode, not balance.
   */
  it('each mode’s key mechanic happens, and both the village and the wolves can win', () => {
    type G = { events: { type: string; payload: unknown }[]; result: { winner: string } | null };
    const has = (type: string) => (g: G) => g.events.some((e) => e.type === type);
    const acts = (role: string) => (g: G) => g.events.some((e) => e.type === 'NIGHT_ACTION' && (e.payload as { role: string }).role === role);
    const wins = (team: string) => (g: G) => g.result?.winner === team;
    const FEATURE: Record<string, [string, (g: G) => boolean, number][]> = {
      'fox-hunt-5': [['the Fox sniffs', has('FOX_RESULT'), 0.6]],
      'night-potions-5': [['the Witch learns the victim', has('WITCH_INFO'), 0.8]],
      'guardians-6': [['the Protector guards', acts('protector'), 0.6]],
      'idiots-gambit-6': [['the Raven loads a vote', has('RAVEN_MARK'), 0.5]],
      'lovers-night-7': [['Cupid links two Lovers', has('LOVER_INFO'), 0.9]],
      'pied-piper-7': [['the Piper charms', has('CHARMED_LIST'), 0.6]],
      'sisters-watch-7': [['the Sisters meet', has('SISTER_INFO'), 0.9]],
      'big-bad-wolf-8': [['the Big Bad Wolf takes a second victim', acts('big_bad_wolf'), 0.3]],
      'signs-and-omens-8': [
        ['the Raven loads a vote', has('RAVEN_MARK'), 0.5],
        ['the bear growls or not', has('BEAR'), 0.5],
      ],
      'double-cross-8': [['someone changes sides', has('PACK_JOINED'), 0.3]],
      'thiefs-game-9': [['the Thief sees the set-aside cards', has('THIEF_OFFER'), 0.9]],
      'angels-bet-9': [['the Angel wins now and then', wins('Angel'), 0.05]],
      'court-day-9': [['the Judge calls a second vote', has('SECOND_VOTE'), 0.2]],
      'full-moon-10': [['the Wolf-Father turns a villager', has('INFECTED'), 0.2]],
      'white-wolf-10': [['the White Werewolf wins now and then', wins('WhiteWolf'), 0.05]],
      'free-for-all-10': [['the Piper charms', has('CHARMED_LIST'), 0.6]],
      'chaos-10': [['the Piper charms', has('CHARMED_LIST'), 0.6]],
    };
    const N = 100;
    for (const m of modes) {
      const games: G[] = [];
      for (let i = 0; i < N; i++) {
        const seed = `feature-${m.id}-${i}`;
        const game: GameConfig = { seed, seats: m.seats, cards: m.cards, rules: resolveSentinels(layerRules(cfg.rules, m.ruleOverrides), m.seats), names: cfg.names, maskNames: [], humanSlots: [] };
        games.push(simulate(game, randomBot(seed)) as unknown as G);
      }
      const share = (f: (g: G) => boolean) => games.filter(f).length / N;
      expect(share(wins('Village')), `${m.id}: the village can win`).toBeGreaterThanOrEqual(0.05);
      expect(share(wins('Werewolf')), `${m.id}: the wolves can win`).toBeGreaterThanOrEqual(0.05);
      for (const [what, f, min] of FEATURE[m.id] ?? []) expect(share(f), `${m.id}: ${what}`).toBeGreaterThanOrEqual(min);
    }
    // every recommended mode states what it is about, as a test
    for (const m of modes) if (m.category === 'recommended') expect(FEATURE[m.id], `${m.id} has no key-mechanic check`).toBeDefined();
  }, 300_000);
});

