import type { DecisionOf, SeatId } from '@ww/shared';
import { PUBLIC, ask, emit } from './core';
import type { Game } from './types';

/**
 * Post-game debrief (ruleset §15b): fun only, never carried into another game.
 *
 * The host is asked first (`debrief_enabled = ask`), unless the rules answer for them
 * (`always` / `never`). Round 1 is written independently by every seat, dead ones included,
 * and only then shown; round 2 is an optional reply round. A seat that gives no usable answer
 * simply has no comment (ruleset §15b.6).
 */
export function debrief(g: Game): void {
  const rules = g.cfg.rules;
  if (!g.cfg.debrief || rules.debrief_enabled === 'never') return;
  g.phase = 'debrief';

  if (rules.debrief_enabled === 'ask') {
    const [r] = ask(g, [{ seat: 0, kind: 'choice', context: 'debrief_accept', legal: { choices: ['open', 'skip'] }, optional: false }]);
    if ((r!.decision as DecisionOf<'choice'>).choice !== 'open') {
      emit(g, 'DEBRIEF_DECLINED', {}, PUBLIC);
      return;
    }
  }
  emit(g, 'DEBRIEF_OPENED', { rounds: rules.debrief_rounds }, PUBLIC);

  const seats = g.seats.map((s) => s.seat);
  for (let round = 1; round <= rules.debrief_rounds; round++) {
    const context = round === 1 ? ('debrief_comment' as const) : ('debrief_reply' as const);
    const words = round === 1 ? rules.words.debrief_comment : rules.words.debrief_reply;
    // Round 1 is one parallel group, so nobody sees another comment while writing (§15b.3).
    const answers = ask(
      g,
      seats.map((seat) => ({ seat, kind: 'speech' as const, context, legal: {}, words, optional: true, round, maxRounds: rules.debrief_rounds })),
    );
    answers.forEach((res, i) => {
      // the text is already sanitised and word-limited by the engine; "(pass)" means no comment
      const text = (res.decision as DecisionOf<'speech'>).speech;
      if (text && text !== '(pass)') emit(g, 'DEBRIEF_COMMENT', { seat: seats[i] as SeatId, round, text }, PUBLIC);
    });
  }
}
