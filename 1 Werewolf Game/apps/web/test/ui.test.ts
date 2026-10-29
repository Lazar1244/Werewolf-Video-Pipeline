// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@ww/client-sdk';
import { initialState, pending, reduce, type AppState } from '../src/app';
import { renderTable } from '../src/views/table';
import { renderLog } from '../src/views/log';
import { buildDecision, canSubmit, renderTimer, renderTurn } from '../src/views/turn';
import { renderHost, renderRole } from '../src/views/side';
import { renderWaitingRoom } from '../src/views/lobby';

/**
 * The browser client, tested the way a player meets it: feed it the messages the server sends
 * and check what ends up on the screen — above all, that nothing hidden does.
 */
const seats = [
  { seat: 1, name: 'Alba' },
  { seat: 2, name: 'Bram' },
  { seat: 3, name: 'Cora' },
  { seat: 4, name: 'Dario' },
  { seat: 5, name: 'Elin' },
];

const at = (phase: string, day = 1, night = 1) => ({ phase, day, night });

function entry(vseq: number, type: string, payload: unknown, opts: { phase?: string; day?: number; night?: number; to?: number[] } = {}) {
  // `to` is what the server sends for a private entry: the seats it was addressed to
  return { vseq, at: at(opts.phase ?? 'day', opts.day ?? 1, opts.night ?? 1), type, payload, ...(opts.to ? { private: true, seats: opts.to } : {}) };
}

/** A seat view: the game as one player is allowed to see it. */
function seatHello(over: Partial<{ entries: unknown[]; pending: unknown; lockOpen: boolean }> = {}): ServerMessage {
  return {
    type: 'hello',
    scope: 'seat',
    principal: { kind: 'seat', seat: 3, slot: 3, name: 'Cora' },
    gameId: 'g1',
    status: 'running',
    lockOpen: over.lockOpen ?? false,
    view: null,
    entries: over.entries ?? [
      entry(1, 'GAME_START', { seats, composition: ['werewolf', 'seer', 'villager', 'villager', 'witch'], extras: 0, rules: {} }),
      entry(2, 'ROLE_ASSIGNED', { seat: 3, role: 'seer', team: 'Village' }, { to: [3] }),
      entry(3, 'PHASE_START', { phase: 'night', night: 1 }, { phase: 'night' }),
    ],
    lastVseq: 3,
    pending: (over.pending as never) ?? null,
  } as ServerMessage;
}

const mount = () => document.createElement('div');
const hostHnd = (command: (c: Record<string, unknown>) => unknown = () => undefined) => ({ command: (c: Record<string, unknown>) => void command(c), reissue: () => undefined, remap: () => undefined, spectatorLink: () => undefined });

function stateFrom(...messages: ServerMessage[]): AppState {
  let s = initialState('g1');
  for (const m of messages) s = reduce(s, m).state;
  return s;
}

describe('the client state', () => {
  it('knows which principal it is and keeps the feeds apart', () => {
    const s = stateFrom(seatHello(), { ...seatHello(), scope: 'host', principal: { kind: 'host' }, entries: [], lastVseq: 0 } as ServerMessage);
    expect(s.isSeat).toBe(true);
    expect(s.isHost).toBe(true);
    expect(s.client.scopes.seat.lastVseq).toBe(3);
    expect(s.client.scopes.host.lastVseq).toBe(0);
  });

  it('starts a fresh answer for each new request, and clears it when accepted', () => {
    const req = { clientRequestId: 'r1', kind: 'vote', context: 'day', legal: { targets: [1, 2] }, optional: false, deadlineAt: Date.now() + 60_000 };
    let s = stateFrom(seatHello(), { type: 'decision_request', scope: 'seat', request: req } as ServerMessage);
    expect(s.draft.requestId).toBe('r1');
    s = { ...s, draft: { ...s.draft, target: 2 } };
    expect(canSubmit(s)).toBe(true);
    expect(buildDecision(s)).toEqual({ vote: 2 });
    s = reduce(s, { type: 'decision_accepted', scope: 'seat', clientRequestId: 'r1' } as ServerMessage).state;
    expect(s.draft.sent).toBe(true);
    expect(canSubmit(s)).toBe(false);
  });

  it('shows why an answer was refused', () => {
    let s = stateFrom(seatHello(), { type: 'decision_request', scope: 'seat', request: { clientRequestId: 'r1', kind: 'vote', context: 'day', legal: { targets: [1] }, optional: false, deadlineAt: null } } as ServerMessage);
    s = reduce(s, { type: 'decision_error', scope: 'seat', clientRequestId: 'r1', issues: ['vote: not a legal target'] } as ServerMessage).state;
    expect(s.issues).toEqual(['vote: not a legal target']);
    expect(s.draft.sent).toBe(false);
  });

  it('asks for a fresh snapshot when entries are missed', () => {
    const s = stateFrom(seatHello());
    const { resync } = reduce(s, { type: 'entries', scope: 'seat', fromVseq: 9, entries: [] } as ServerMessage);
    expect(resync).toBe(true);
  });
});

describe('what reaches the screen', () => {
  it('a seat sees its own role and nobody else’s', () => {
    const s = stateFrom(seatHello());
    const role = mount();
    renderRole(role, s);
    expect(role.textContent).toContain('Seer');
    expect(role.textContent).toContain('Cora');

    const table = mount();
    renderTable(table, s, { onPick: () => undefined });
    // five seats, no roles on show while everyone is alive
    expect(table.querySelectorAll('.seat')).toHaveLength(5);
    // the cards in play are public; what must never show is a card on another player's seat
    const seatText = [...table.querySelectorAll('.seat')].map((x) => x.textContent).join(' ');
    expect(seatText).not.toContain('Werewolf');
    expect(seatText).not.toContain('Witch');
  });

  it('a private notice is written about its owner, not to the reader', () => {
    const s = stateFrom(
      seatHello({
        lockOpen: true,
        entries: [
          entry(1, 'GAME_START', { seats, composition: ['werewolf'], extras: 0, rules: {} }),
          entry(2, 'ROLE_ASSIGNED', { seat: 1, role: 'werewolf', team: 'Werewolf' }, { to: [1] }),
          entry(3, 'SEER_RESULT', { target: 1, result: 'werewolf' }, { to: [3] }),
          entry(4, 'ROLE_ASSIGNED', { seat: 3, role: 'seer', team: 'Village' }, { to: [3] }),
        ],
      }),
    );
    const log = mount();
    renderLog(log, s);
    const text = log.textContent ?? '';
    expect(text).toContain('Alba is the Werewolf'); // about someone else
    expect(text).toContain('You are the Seer'); // this reader's own card
    expect(text).toContain('Your vision: Alba is a WEREWOLF'); // and the reader's own result, unchanged
  });

  it('shows speeches with their suspicion and claim, and thoughts only when they are given', () => {
    const s = stateFrom(
      seatHello({
        entries: [
          entry(1, 'GAME_START', { seats, composition: ['werewolf'], extras: 0, rules: {} }),
          entry(2, 'SPEECH', { seat: 2, context: 'discussion', round: 1, text: 'I think Dario is hiding something.', lean: 4, claim: { role: 'seer', result: 'Alba is clean' } }),
          entry(3, 'SEAT_THOUGHTS', { seat: 3, requestId: 1, context: 'discussion', reasoning: 'I will keep my head down.', notebook: null }, { to: [3] }),
        ],
      }),
    );
    const log = mount();
    renderLog(log, s);
    expect(log.textContent).toContain('I think Dario is hiding something.');
    expect(log.textContent).toContain('suspects Dario');
    expect(log.textContent).toContain('claims to be the Seer: Alba is clean');
    expect(log.textContent).toContain('Cora thinks: I will keep my head down.');
  });

  it('the table turns into the picker when a target is needed', () => {
    const req = { clientRequestId: 'r2', kind: 'target', context: 'seer', legal: { targets: [1, 2] }, optional: false, deadlineAt: null };
    let s = stateFrom(seatHello({ pending: req }));
    const picked: number[] = [];
    const table = mount();
    renderTable(table, s, { onPick: (seat) => picked.push(seat) });
    const targets = table.querySelectorAll('.seat.target');
    expect(targets).toHaveLength(2);
    (targets[0] as HTMLElement).click();
    expect(picked).toEqual([1]);

    s = { ...s, draft: { ...s.draft, target: 1 } };
    const again = mount();
    renderTable(again, s, { onPick: () => undefined });
    expect(again.querySelectorAll('.seat.chosen')).toHaveLength(1);
  });
});

describe('the turn panel', () => {
  const render = (req: Record<string, unknown>, draft: Partial<AppState['draft']> = {}) => {
    const s0 = stateFrom(seatHello({ pending: req }));
    const s = { ...s0, draft: { ...s0.draft, ...draft } };
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    return { body, s };
  };

  it('asks a plain question for each kind of turn', () => {
    expect(render({ clientRequestId: 'a', kind: 'vote', context: 'day', legal: { targets: [1, 2] }, optional: false, deadlineAt: null }).body.textContent).toContain('who should the village execute');
    expect(render({ clientRequestId: 'b', kind: 'target', context: 'seer', legal: { targets: [1] }, optional: false, deadlineAt: null }).body.textContent).toContain('look at tonight');
    expect(render({ clientRequestId: 'c', kind: 'witch', context: 'witch', legal: { canHeal: true, healTarget: 2, poisonTargets: [1, 4] }, optional: true, deadlineAt: null }).body.textContent).toContain('The wolves attacked Bram');
    const speech = render({ clientRequestId: 'd', kind: 'speech', context: 'discussion', round: 2, maxRounds: 2, words: 120, legal: { leanTargets: [1, 2] }, optional: false, deadlineAt: null });
    expect(speech.body.textContent).toContain('round 2 of 2');
    expect(speech.body.querySelector('textarea')).not.toBeNull();
  });

  it('counts the words against the limit', () => {
    const { body } = render({ clientRequestId: 'e', kind: 'speech', context: 'discussion', words: 5, legal: {}, optional: false, deadlineAt: null }, { text: 'one two three four five six' });
    const counter = body.querySelector('.words');
    expect(counter?.textContent).toContain('6 / 5 words');
    expect(counter?.className).toContain('over');
  });

  it('will not send an answer that is not ready', () => {
    const { s } = render({ clientRequestId: 'f', kind: 'multi', context: 'scapegoat_ruling', legal: { targets: [1, 2, 3], min: 1 }, optional: false, deadlineAt: null });
    expect(canSubmit(s)).toBe(false);
    const ready = { ...s, draft: { ...s.draft, multi: [1] } };
    expect(canSubmit(ready)).toBe(true);
    expect(buildDecision(ready)).toEqual({ targets: [1] });
  });

  it('builds the decision the engine expects for every kind', () => {
    const cases: [Record<string, unknown>, Partial<AppState['draft']>, unknown][] = [
      [{ clientRequestId: '1', kind: 'speech', context: 'discussion', legal: {}, optional: false, deadlineAt: null }, { text: 'hello', lean: 2 }, { speech: 'hello', lean: 2, claim: null }],
      [
        { clientRequestId: '1b', kind: 'speech', context: 'discussion', legal: {}, optional: false, deadlineAt: null },
        { text: 'I saw Alba', lean: 1, claimRole: 'seer', claimResult: 'Alba is a wolf' },
        { speech: 'I saw Alba', lean: 1, claim: { role: 'seer', result: 'Alba is a wolf' } },
      ],
      [{ clientRequestId: '2', kind: 'vote', context: 'day', legal: { targets: [1] }, optional: false, deadlineAt: null }, { target: 'abstain' }, { vote: 'abstain' }],
      [{ clientRequestId: '3', kind: 'witch', context: 'witch', legal: { poisonTargets: [1] }, optional: true, deadlineAt: null }, { heal: true, target: 1 }, { heal: true, poison: 1 }],
      [{ clientRequestId: '4', kind: 'choice', context: 'little_girl', legal: { choices: ['spy', 'sleep'] }, optional: false, deadlineAt: null }, { choice: 'sleep' }, { choice: 'sleep' }],
      [{ clientRequestId: '5', kind: 'sheriff_run', context: 'sheriff_run', legal: {}, optional: false, deadlineAt: null }, { run: true }, { run: true }],
      [{ clientRequestId: '6', kind: 'council_turn', context: 'council', legal: { targets: [1] }, optional: false, deadlineAt: null }, { text: 'take Alba', target: 1, ready: true }, { message: 'take Alba', proposed_target: 1, ready: true }],
      [{ clientRequestId: '7', kind: 'pair', context: 'cupid', legal: { targets: [1, 2, 3] }, optional: false, deadlineAt: null }, { multi: [1, 3] }, { targets: [1, 3] }],
      [{ clientRequestId: '8', kind: 'message', context: 'lovers_channel', legal: {}, optional: true, deadlineAt: null }, { text: 'be careful' }, { message: 'be careful' }],
    ];
    for (const [req, draft, expected] of cases) {
      const { s } = render(req, draft);
      expect(buildDecision(s), String(req['kind'])).toEqual(expected);
    }
  });

  it('an empty speech is a pass, never an empty line', () => {
    const { s } = render({ clientRequestId: '9', kind: 'speech', context: 'discussion', legal: {}, optional: false, deadlineAt: null }, { text: '   ' });
    expect(buildDecision(s)).toMatchObject({ speech: '(pass)' });
  });
});

describe('the states a player can end up in', () => {
  const req = { clientRequestId: 'r9', kind: 'vote', context: 'day', legal: { targets: [1, 2] }, optional: false, deadlineAt: Date.now() + 60_000 };

  it('a pause freezes the clock and re-delivering the request keeps what was written', () => {
    let s = stateFrom(seatHello(), { type: 'decision_request', scope: 'seat', request: req } as ServerMessage);
    s = { ...s, draft: { ...s.draft, text: 'half a sentence', target: 2 } };
    s = reduce(s, { type: 'paused', reason: 'cost_cap' } as ServerMessage).state;
    expect(s.client.paused).toEqual({ reason: 'cost_cap' });

    // the server re-sends the same request with a frozen deadline
    s = reduce(s, { type: 'decision_request', scope: 'seat', request: { ...req, deadlineAt: null } } as ServerMessage).state;
    expect(s.draft.text).toBe('half a sentence');
    expect(s.draft.target).toBe(2);
    expect(pending(s)!.deadlineAt).toBeNull();

    const bar = mount();
    renderTimer(bar, pending(s), s.timing);
    expect(bar.title).toContain('frozen');

    s = reduce(s, { type: 'resumed' } as ServerMessage).state;
    expect(s.client.paused).toBeNull();
    expect(s.draft.text).toBe('half a sentence');
  });

  it('a new request does replace an old half-written answer', () => {
    let s = stateFrom(seatHello(), { type: 'decision_request', scope: 'seat', request: req } as ServerMessage);
    s = { ...s, draft: { ...s.draft, text: 'about the last vote' } };
    s = reduce(s, { type: 'decision_request', scope: 'seat', request: { ...req, clientRequestId: 'r10' } } as ServerMessage).state;
    expect(s.draft.text).toBe('');
    expect(s.draft.requestId).toBe('r10');
  });

  it('the end of the game takes the question away', () => {
    let s = stateFrom(seatHello(), { type: 'decision_request', scope: 'seat', request: req } as ServerMessage);
    expect(pending(s)).not.toBeNull();
    s = reduce(s, { type: 'game_over', winner: 'Village', reason: 'no wolves left' } as ServerMessage).state;
    expect(pending(s)).toBeNull();
    expect(s.client.status).toBe('over');
  });

  it('an abandoned game says so, and stops asking for an answer', () => {
    let s = stateFrom(seatHello(), { type: 'decision_request', scope: 'seat', request: req } as ServerMessage);
    s = reduce(s, { type: 'aborted', reason: 'the host ended this game' } as ServerMessage).state;
    expect(s.client.status).toBe('aborted');
    expect(pending(s)).toBeNull();
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    expect(body.textContent).toContain('Nothing to do');
  });

  it('keeps the server’s complaint so it can be shown, and lets it be cleared', () => {
    let s = stateFrom(seatHello());
    s = reduce(s, { type: 'error', message: 'too many messages; slow down' } as ServerMessage).state;
    expect(s.error).toBe('too many messages; slow down');
    expect(reduce(s, { type: 'pong' } as ServerMessage).state.error).toBe('too many messages; slow down');
  });

  it('turns someone else’s link away instead of waiting forever', () => {
    const root = mount();
    renderWaitingRoom(root, null, [], { refused: 'This device is not part of that game.', waiting: false });
    expect(root.textContent).toContain('not part of that game');
    expect(root.textContent).toContain('Ask the host');

    const fresh = mount();
    renderWaitingRoom(fresh, null, [], { refused: null, waiting: false });
    expect(fresh.textContent).toContain('needs a join link');
  });
});

describe('the host’s screen', () => {
  const hostHello = (over: Partial<{ entries: unknown[] }> = {}): ServerMessage =>
    ({
      type: 'hello',
      scope: 'host',
      principal: { kind: 'host' },
      gameId: 'g1',
      status: 'running',
      lockOpen: false,
      view: null,
      entries: over.entries ?? [entry(1, 'GAME_START', { seats, composition: ['werewolf', 'seer', 'villager', 'villager', 'witch'], extras: 0, rules: {} }), entry(2, 'PHASE_START', { phase: 'night', night: 1 }, { phase: 'night' })],
      lastVseq: 2,
      pending: null,
    }) as ServerMessage;

  const status = (over: Record<string, unknown> = {}): ServerMessage =>
    ({ type: 'host_status', scope: 'host', status: 'running', pauseReason: null, disconnectedSlots: [], costUsd: 0.25, costCapUsd: 2, lockOpen: false, debriefPending: false, ...over }) as ServerMessage;

  it('shows the status and the cost, and no seat detail while the game is hidden', () => {
    const s = stateFrom(hostHello(), status());
    const body = mount();
    renderHost(body, s, hostHnd());
    expect(body.textContent).toContain('$0.25 of $2.00');
    expect(body.textContent).toContain('hidden until no human can act');

    // the host's feed is the public one: it carries no card for anyone
    const table = mount();
    renderTable(table, s, { onPick: () => undefined });
    expect(table.querySelectorAll('.seat')).toHaveLength(5);
    expect([...table.querySelectorAll('.seat')].map((x) => x.textContent).join(' ')).not.toMatch(/Werewolf|Seer|Witch/);
    const role = mount();
    renderRole(role, s);
    expect(role.textContent).toContain('hosting this game');
  });

  it('offers the debrief only when the game is waiting for that answer', () => {
    const body = mount();
    renderHost(body, stateFrom(hostHello(), status()), hostHnd());
    expect(body.textContent).not.toContain('Open the debrief');

    const sent: Record<string, unknown>[] = [];
    const offered = mount();
    renderHost(offered, stateFrom(hostHello(), status({ status: 'over_offer', debriefPending: true })), hostHnd((c) => sent.push(c)));
    expect(offered.textContent).toContain('Open the debrief');
    (offered.querySelector('button.primary') as HTMLElement).click();
    expect(sent[0]).toEqual({ cmd: 'debrief', open: true });
  });

  it('can settle a wedged turn without abandoning the game', () => {
    const sent: Record<string, unknown>[] = [];
    const body = mount();
    renderHost(body, stateFrom(hostHello(), status()), hostHnd((c) => sent.push(c)));
    const buttons = [...body.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Settle the current turn');
    expect(buttons).toContain('Settle every open vote');
    ([...body.querySelectorAll('button')].find((b) => b.textContent === 'Settle the current turn') as HTMLElement).click();
    expect(sent[0]).toEqual({ cmd: 'fallback_now', target: 'current_speaker' });
  });
});

describe('a spectator once the game is open', () => {
  const specHello = (): ServerMessage =>
    ({
      type: 'hello',
      scope: 'spectator',
      principal: { kind: 'spectator' },
      gameId: 'g1',
      status: 'running',
      lockOpen: true,
      view: null,
      entries: [
        entry(1, 'GAME_START', { seats, composition: ['werewolf', 'seer', 'villager', 'villager', 'witch'], extras: 0, rules: {} }),
        entry(2, 'ROLE_ASSIGNED', { seat: 1, role: 'werewolf', team: 'Werewolf' }, { to: [1] }),
        entry(3, 'ROLE_ASSIGNED', { seat: 2, role: 'seer', team: 'Village' }, { to: [2] }),
      ],
      lastVseq: 3,
      pending: null,
    }) as ServerMessage;

  it('can read the cards off the table, not only out of the log', () => {
    const s = stateFrom(specHello());
    const table = mount();
    renderTable(table, s, { onPick: () => undefined });
    expect(table.textContent).toContain('Werewolf');
    expect(table.textContent).toContain('Seer');
    // a seat with no card in this feed is still shown plainly
    expect(table.querySelectorAll('.seat')).toHaveLength(5);
  });

  it('is told it is watching, and is offered nothing to do', () => {
    const s = stateFrom(specHello());
    const role = mount();
    renderRole(role, s);
    expect(role.textContent).toContain('watching');
    const turn = mount();
    renderTurn(turn, s, { change: () => undefined, submit: () => undefined });
    expect(turn.textContent).toContain('watching');
  });
});

describe('Challenges (ruleset §9.2)', () => {
  const turn = (pendingReq: Record<string, unknown>, draft: Partial<AppState['draft']> = {}) => {
    const s0 = stateFrom(seatHello({ pending: pendingReq }));
    const s = { ...s0, draft: { ...s0.draft, ...draft } };
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    return { body, s };
  };
  const speech = (legal: Record<string, unknown>) => ({ clientRequestId: 'ch', kind: 'speech', context: 'discussion', round: 1, maxRounds: 2, words: 120, legal, optional: false, deadlineAt: null });

  it('offers the Challenge row only while the player has one, and sends the chosen seat', () => {
    const offered = turn(speech({ leanTargets: [1, 2, 4, 5], challengeTargets: [1, 2, 4, 5] }), { text: 'Why so quiet, Bram?', challenge: 2 });
    expect(offered.body.textContent).toContain('Challenge someone?');
    expect(buildDecision(offered.s)).toMatchObject({ speech: 'Why so quiet, Bram?', challenge: 2 });
    const none = turn(speech({ leanTargets: [1, 2, 4, 5] }), { text: 'Hm.', challenge: 2 });
    expect(none.body.textContent).not.toContain('Challenge someone?');
    expect(buildDecision(none.s)).not.toHaveProperty('challenge');
  });

  it('tells a challenged player to answer at once, and the log shows the call-out and the answer', () => {
    const answer = turn({ clientRequestId: 'ca', kind: 'speech', context: 'challenge_answer', words: 60, legal: { leanTargets: [1, 2, 4, 5] }, optional: false, deadlineAt: null });
    expect(answer.body.textContent).toContain('You have been challenged!');
    const named = stateFrom(
      seatHello({
        entries: [
          entry(1, 'GAME_START', { seats, composition: ['werewolf', 'seer', 'villager', 'villager', 'witch'], extras: 0, rules: {} }),
          entry(2, 'ROLE_ASSIGNED', { seat: 3, role: 'villager', team: 'Village' }, { to: [3] }),
          entry(3, 'CHALLENGE', { seat: 1, target: 3, round: 1 }),
        ],
        pending: { clientRequestId: 'cb', kind: 'speech', context: 'challenge_answer', words: 60, legal: { leanTargets: [1, 2, 4, 5] }, optional: false, deadlineAt: null },
      }),
    );
    const namedBody = mount();
    renderTurn(namedBody, named, { change: () => undefined, submit: () => undefined });
    expect(namedBody.textContent).toContain('Alba challenged you!');
    expect(answer.body.textContent).not.toContain('Challenge someone?');
    const s = stateFrom(
      seatHello({
        entries: [
          entry(1, 'GAME_START', { seats, composition: ['werewolf', 'seer', 'villager', 'villager', 'witch'], extras: 0, rules: {} }),
          entry(2, 'PHASE_START', { phase: 'day', day: 1 }),
          entry(3, 'SPEECH', { seat: 1, context: 'discussion', round: 1, text: 'Cora, explain yourself.', lean: 3, claim: null }),
          entry(4, 'CHALLENGE', { seat: 1, target: 3, round: 1 }),
          entry(5, 'SPEECH', { seat: 3, context: 'challenge_answer', round: 1, text: 'I was listening.', lean: null, claim: null }),
        ],
      }),
    );
    const log = mount();
    renderLog(log, s);
    expect(log.textContent).toContain('challenges');
    expect(log.textContent).toContain('answers the challenge');
  });
});
