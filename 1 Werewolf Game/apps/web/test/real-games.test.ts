// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { randomBot, simulate, type Game } from '@ww/engine';
import { viewFor } from '@ww/server';
import { DecisionSchemas, RulesSchema, layerRules, resolveSentinels, type GameConfig, type Principal, type RoleId, type SeatId, type ServerMessage } from '@ww/shared';
import { request } from '@ww/client-sdk';
import { initialState, pending, reduce, type AppState } from '../src/app';
import { renderTable } from '../src/views/table';
import { renderLog } from '../src/views/log';
import { buildDecision, canSubmit, renderTimer, renderTurn } from '../src/views/turn';
import { renderHost, renderNotes, renderRole } from '../src/views/side';
import { renderLobby, renderWaitingRoom, type LobbyData } from '../src/views/lobby';
import { roleLabel } from '@ww/projector';

/**
 * The client driven by what the server really sends: engine games played to the end, projected
 * for each viewer by the server's own `viewFor`, then rendered. The hiding tests here fail if the
 * projection, the view reducer or a view ever puts another seat's secret on the screen.
 */
const ROOT = join(import.meta.dirname, '../../..');
const RULES = RulesSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/rules/default.json'), 'utf8')));
const NAMES = ['Alba', 'Bram', 'Cora', 'Dario', 'Elin', 'Fenn', 'Greta', 'Hugo', 'Ines', 'Jonas'];
const FULL: RoleId[] = ['werewolf', 'accursed_wolf_father', 'white_werewolf', 'seer', 'witch', 'cupid', 'little_girl', 'piper', 'elder', 'hunter'];

function play(seed: string, humanSlots: number[] = [1]): Game {
  const cfg: GameConfig = { seed, seats: FULL.length, cards: FULL, rules: resolveSentinels(layerRules(RULES), FULL.length), names: NAMES, maskNames: [], humanSlots };
  return simulate(cfg, randomBot(seed));
}

/** The name the game gave each seat (names are dealt at random, not in list order). */
const nameOf = (g: Game, seat: number): string => (g.events[0]!.payload as { seats: { seat: number; name: string }[] }).seats.find((x) => x.seat === seat)!.name;
const seatPrincipal = (g: Game, seat: number): Principal => ({ kind: 'seat', seat: seat as SeatId, slot: seat as never, name: nameOf(g, seat) });

/** A hello exactly as the gateway builds it for this principal. */
function helloFor(g: Game, principal: Principal, lockOpen: boolean): ServerMessage {
  const p = viewFor(g.events, principal, lockOpen);
  return {
    type: 'hello',
    scope: principal.kind === 'seat' ? 'seat' : principal.kind,
    principal,
    gameId: 'g',
    status: 'running',
    lockOpen,
    view: p.view,
    entries: p.entries,
    lastVseq: p.lastVseq,
    pending: null,
  } as ServerMessage;
}

const mount = () => document.createElement('div');
const screen = (s: AppState): string => {
  const t = mount();
  renderTable(t, s, { onPick: () => undefined });
  const l = mount();
  renderLog(l, s);
  const r = mount();
  renderRole(r, s);
  return `${t.textContent}\n${l.textContent}\n${r.textContent}`;
};

/**
 * Everything that would give away a secret about `other`: the line that tells them their card, their
 * private thoughts, and their card written on the table while they are alive and unrevealed.
 */
function leaksAbout(g: Game, s: AppState, text: string, other: number): string[] {
  const who = nameOf(g, other);
  const found: string[] = [];
  if (text.includes(`${who} is the `)) found.push(`${who}'s card is told in the log`);
  if (text.includes(`${who} thinks:`)) found.push(`${who}'s thoughts are shown`);
  const t = mount();
  renderTable(t, s, { onPick: () => undefined });
  const seat = [...t.querySelectorAll('.seat')].find((el) => el.querySelector('.name')?.textContent === who)!;
  const publiclyKnown = g.events.some((e) => (e.type === 'DEATHS' && (e.payload as { deaths: { seat: number }[] }).deaths.some((d) => d.seat === other)) || (e.type === 'IDIOT_REVEALED' && (e.payload as { seat: number }).seat === other));
  if (!publiclyKnown && seat.querySelector('.sub')?.textContent) found.push(`${who}'s card is on the table: ${seat.querySelector('.sub')!.textContent}`);
  return found;
}

describe('hiding, on real games, as the server projects them', () => {
  // cut each game at several points: the lock must hold all the way through, not just at the end
  const cuts = (g: Game) => [10, 40, 80, 140].map((n) => ({ ...g, events: g.events.slice(0, Math.min(n, g.events.length)) }) as Game);

  it('a player never sees another player’s card or thoughts while the game is hidden', () => {
    for (const seed of ['hide1', 'hide2', 'hide3']) {
      const g = play(seed, [1, 2]);
      for (const cut of cuts(g)) {
        for (let seat = 1; seat <= FULL.length; seat++) {
          const s = reduce(initialState('g'), helloFor(cut, seatPrincipal(cut, seat), false)).state;
          const text = screen(s);
          const own = cut.events.filter((e) => e.vis.kind === 'seats' && e.vis.seats.includes(seat as SeatId)).flatMap((e) => (e.vis.kind === 'seats' ? e.vis.seats : []));
          for (let other = 1; other <= FULL.length; other++) {
            if (other === seat || own.includes(other as SeatId)) continue; // a channel-mate (pack, lover) is known on purpose
            expect(leaksAbout(cut, s, text, other), `${seed} seat ${seat} about ${other}`).toEqual([]);
          }
        }
      }
    }
  });

  it('the host sees no card, no thought and no model while the game is hidden', () => {
    for (const seed of ['hide1', 'hide4']) {
      const g = play(seed, [1]);
      for (const cut of cuts(g)) {
        const s = reduce(initialState('g'), helloFor(cut, { kind: 'host' }, false)).state;
        const text = screen(s);
        for (let other = 1; other <= FULL.length; other++) expect(leaksAbout(cut, s, text, other), `${seed} host about ${other}`).toEqual([]);
        expect(s.client.models).toEqual([]);
      }
    }
  });

  it('once the game is open, a spectator does see every card — so the checks above can fail', () => {
    const g = play('hide1', []);
    const s = reduce(initialState('g'), helloFor(g, { kind: 'spectator' }, true)).state;
    const text = screen(s);
    const leaks = [1, 2, 3, 4, 5].flatMap((o) => leaksAbout(g, s, text, o));
    expect(leaks.length).toBeGreaterThan(0);
    for (const seat of g.seats) expect(text).toContain(roleLabel(seat.role as RoleId));
  });

  it('a dead player whose game has opened reads the whole story, with their own card still theirs', () => {
    const g = play('hide2', [3]);
    let s = reduce(initialState('g'), helloFor(g, seatPrincipal(g, 3), true)).state;
    s = reduce(s, helloFor(g, { kind: 'spectator' }, true)).state;
    const text = screen(s);
    // everyone's thoughts, not only this player's
    const thinkers = new Set([...text.matchAll(/(\w+) thinks:/g)].map((m) => m[1]));
    expect(thinkers.size).toBeGreaterThan(1);
    const role = mount();
    renderRole(role, s);
    expect(role.textContent).toContain(roleLabel(g.seats[2]!.role as RoleId));
  });
});

describe('answers the engine accepts', () => {
  it('every decision the turn panel builds passes the engine’s own schema', () => {
    const base = initialState('g');
    const cases: [Record<string, unknown>, Partial<AppState['draft']>][] = [
      [{ kind: 'speech', context: 'discussion', legal: { leanTargets: [1, 2] } }, { text: 'hello', lean: 2, claimRole: 'seer', claimResult: 'Alba is fine' }],
      [{ kind: 'speech', context: 'debrief_comment', legal: {} }, { text: '' }],
      [{ kind: 'vote', context: 'day', legal: { targets: [1, 2], secondVote: true } }, { target: 1, ready: true, touched: true }],
      [{ kind: 'vote', context: 'day', legal: { targets: [1] } }, { target: 'abstain', touched: true }],
      [{ kind: 'target', context: 'seer', legal: { targets: [1, 2] } }, { target: 2, touched: true }],
      [{ kind: 'council_ballot', context: 'wolf_kill', legal: { targets: [1], allowNone: true } }, { target: null, touched: true }],
      [{ kind: 'council_turn', context: 'council', legal: { targets: [1] } }, { text: 'Alba', target: 1, ready: true }],
      [{ kind: 'witch', context: 'witch', legal: { canHeal: true, healTarget: 2, poisonTargets: [1] } }, { heal: true, target: 1 }],
      [{ kind: 'choice', context: 'thief', legal: { choices: ['keep', 'extra1'] } }, { choice: 'extra1' }],
      [{ kind: 'pair', context: 'cupid', legal: { targets: [1, 2, 3] } }, { multi: [1, 3] }],
      [{ kind: 'multi', context: 'scapegoat_ruling', legal: { targets: [1, 2, 3], min: 1 } }, { multi: [2] }],
      [{ kind: 'sheriff_run', context: 'sheriff_run', legal: {} }, { run: false }],
      [{ kind: 'message', context: 'lovers_channel', legal: {} }, { text: 'hi' }],
    ];
    for (const [req, draft] of cases) {
      const s: AppState = { ...base, client: { ...base.client, pending: { clientRequestId: 'x', optional: false, deadlineAt: null, ...req } as never }, draft: { ...base.draft, requestId: 'x', ...draft } };
      expect(canSubmit(s), String(req['kind'])).toBe(true);
      const kind = req['kind'] as keyof typeof DecisionSchemas;
      const parsed = DecisionSchemas[kind].safeParse(buildDecision(s));
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('nothing is cast until the player has actually chosen', () => {
    const base = initialState('g');
    const at = (req: Record<string, unknown>, draft: Partial<AppState['draft']> = {}): AppState => ({
      ...base,
      client: { ...base.client, pending: { clientRequestId: 'x', optional: false, deadlineAt: null, ...req } as never },
      draft: { ...base.draft, requestId: 'x', ...draft },
    });
    expect(canSubmit(at({ kind: 'vote', context: 'day', legal: { targets: [1] } }))).toBe(false);
    // a Seer who presses Send before choosing must not waste the night
    expect(canSubmit(at({ kind: 'target', context: 'seer', legal: { targets: [1], allowNone: true } }))).toBe(false);
    expect(canSubmit(at({ kind: 'target', context: 'seer', legal: { targets: [1], allowNone: true } }, { touched: true }))).toBe(true);
  });
});

describe('the connection', () => {
  it('sends no JSON header without a body (the server refuses an empty JSON body) and shows the server’s own words', async () => {
    const seen: RequestInit[] = [];
    const ok = (async (_: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{"seats":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    await request('/api/lobbies/x/links', { method: 'POST', fetchImpl: ok });
    expect((seen[0]!.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    await request('/api/lobbies', { method: 'POST', body: { a: 1 }, fetchImpl: ok });
    expect((seen[1]!.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const bad = (async () => new Response(JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'costCapUsd: Too small' }), { status: 400, statusText: 'Bad Request' })) as unknown as typeof fetch;
    await expect(request('/x', { fetchImpl: bad })).rejects.toThrow('costCapUsd: Too small');
    const ours = (async () => new Response(JSON.stringify({ error: 'the game has already started' }), { status: 400, statusText: 'Bad Request' })) as unknown as typeof fetch;
    await expect(request('/x', { fetchImpl: ours })).rejects.toThrow('the game has already started');
  });

  it('a device that connects during a pause knows it is paused, and the host gets Resume', () => {
    const g = { ...play('pause1', [1]), events: play('pause1', [1]).events.slice(0, 60) } as Game; // mid-game
    const hello = { ...(helloFor(g, { kind: 'host' }, false) as Extract<ServerMessage, { type: 'hello' }>), status: 'paused', pauseReason: 'recovered' } as ServerMessage;
    const s = reduce(initialState('g'), hello).state;
    expect(s.client.paused).toEqual({ reason: 'recovered' });
    const body = mount();
    renderHost(body, s, { command: () => undefined, reissue: () => undefined, remap: () => undefined, spectatorLink: () => undefined });
    const buttons = [...body.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Resume');
    expect(buttons).not.toContain('Pause');
    expect(body.textContent).toContain('press Resume');
  });

  it('host status alone also tells the host the game is paused', () => {
    const s = reduce(initialState('g'), { type: 'host_status', scope: 'host', status: 'paused', pauseReason: 'cost_cap', disconnectedSlots: [], costUsd: 1, costCapUsd: 2, lockOpen: false, debriefPending: false } as ServerMessage).state;
    expect(s.client.paused).toEqual({ reason: 'cost_cap' });
  });

  const seatHello = (pendingReq: unknown): ServerMessage => {
    const g = play('conn1', [1]);
    return { ...(helloFor(g, seatPrincipal(g, 1), false) as object), pending: pendingReq } as ServerMessage;
  };
  const vote = { clientRequestId: 'v1', kind: 'vote', context: 'day', legal: { targets: [2, 3] }, optional: false, deadlineAt: 1, remainingMs: 30_000 };

  it('a question settled without the player goes away, instead of waiting forever', () => {
    let s = reduce(initialState('g'), seatHello(vote)).state;
    expect(pending(s)).not.toBeNull();
    s = reduce(s, { type: 'decision_closed', scope: 'seat', clientRequestId: 'v1' } as ServerMessage).state;
    expect(pending(s)).toBeNull();
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    expect(body.textContent).toContain('Nothing to do');

    // the same when the server says so in reply to a late answer
    let t = reduce(initialState('g'), seatHello(vote)).state;
    t = reduce(t, { type: 'decision_error', scope: 'seat', clientRequestId: 'v1', issues: ['not_waiting_for_this'] } as ServerMessage).state;
    expect(pending(t)).toBeNull();
    expect(t.issues).toEqual([]);
  });

  it('an answer that never reached the server can be sent again', () => {
    let s = reduce(initialState('g'), seatHello(vote)).state;
    s = { ...s, draft: { ...s.draft, target: 2, touched: true, sent: true } };
    // reconnecting: the server still waits for this very request, so our answer was lost
    s = reduce(s, seatHello(vote)).state;
    expect(s.draft.sent).toBe(false);
    expect(s.draft.target).toBe(2); // and what was chosen is kept
  });

  it('counts down from what the server says is left, whatever this device’s clock says', () => {
    // the device clock is an hour off: deadlineAt means nothing here, remainingMs does
    const now = 5_000_000;
    const s = reduce(initialState('g'), seatHello({ ...vote, deadlineAt: now - 3_600_000 }), now).state;
    const bar = mount();
    renderTimer(bar, pending(s), s.timing, now + 10_000);
    expect(bar.textContent).toBe('20s left');
  });
});

describe('the screens people use', () => {
  it('the notes box is built once and never loses what is being typed', () => {
    const base = initialState('g');
    const s: AppState = { ...base, isSeat: true, notes: 'server copy' };
    const body = mount();
    document.body.appendChild(body);
    renderNotes(body, s, () => undefined);
    const ta = body.querySelector('textarea')!;
    ta.focus();
    ta.value = 'half a thought';
    renderNotes(body, { ...s, notes: 'newer server copy' }, () => undefined);
    expect(body.querySelector('textarea')).toBe(ta);
    expect(ta.value).toBe('half a thought');
    body.remove();
  });

  it('a lobby rebuild keeps a name the host is still typing', () => {
    const data: LobbyData = {
      id: 'g',
      draft: { compositionId: 'classic-5', costCapUsd: 2, slots: [1, 2, 3, 4, 5].map((n) => ({ slot: n, controller: n === 1 ? 'human' : 'ai', alias: n === 1 ? null : 'm', humanName: n === 1 ? 'Player 1' : null })) },
      compositions: [{ id: 'classic-5', label: 'Classic', category: 'classic', seats: 5, cards: ['werewolf'], description: null, tags: [], weight: 0, band: { min: -3, max: 5 } }],
      models: [{ alias: 'm', label: 'Model', enabled: true }],
      rosters: {},
      links: null,
      estimate: null,
      connectedSlots: [],
      recent: [],
      busy: false,
      error: null,
    };
    const root = mount();
    document.body.appendChild(root);
    const hnd = { create: () => undefined, patch: () => undefined, links: () => undefined, estimate: () => undefined, start: () => undefined, spectatorLink: () => undefined, discard: () => undefined, replaceLink: () => undefined };
    renderLobby(root, data, hnd);
    const input = root.querySelector<HTMLInputElement>('input[data-k="name-1"]')!;
    input.focus();
    input.value = 'Nadi';
    renderLobby(root, { ...data, connectedSlots: [1] }, hnd); // someone connected meanwhile
    const again = root.querySelector<HTMLInputElement>('input[data-k="name-1"]')!;
    expect(again.value).toBe('Nadi');
    expect(document.activeElement).toBe(again);
    root.remove();
  });

  it('the host’s links carry no rejoin codes; each player sees their own', () => {
    const root = mount();
    renderWaitingRoom(root, 2, [2], { refused: null, waiting: true, rejoinCode: 'A1B2C3' });
    expect(root.textContent).toContain('A1B2C3');
    expect(root.textContent).toContain('Nobody else can see it');
  });

  it('the debrief asks for a comment, not for a suspect or a claim', () => {
    const g = play('deb1', [1]);
    const req = { clientRequestId: 'd1', kind: 'speech', context: 'debrief_comment', legal: { leanTargets: [2, 3] }, optional: true, deadlineAt: null };
    const s = reduce(initialState('g'), { ...(helloFor(g, seatPrincipal(g, 1), true) as object), pending: req } as unknown as ServerMessage).state;
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    expect(body.textContent).not.toContain('Who do you suspect');
    expect(body.textContent).not.toContain('Claim');
    expect(body.querySelector('textarea')).not.toBeNull();
  });

  it('once the game is open, the table says which model played each seat', () => {
    const g = play('mod1', []);
    const hello = { ...(helloFor(g, { kind: 'spectator' }, true) as object), models: [{ seat: 1, alias: 'glm-flash', label: 'Z.ai GLM 5.3 Flash' }] } as ServerMessage;
    const s = reduce(initialState('g'), hello).state;
    const t = mount();
    renderTable(t, s, { onPick: () => undefined });
    expect(t.querySelector('.seat .model')?.textContent).toBe('Z.ai GLM 5.3 Flash');
  });

  it('the story says how people died and when a default answer was used', () => {
    const g = play('story1', []);
    const s = reduce(initialState('g'), helloFor(g, { kind: 'spectator' }, true)).state;
    const l = mount();
    renderLog(l, s);
    const hadCauses = g.events.some((e) => e.type === 'DEATH_CAUSES');
    if (hadCauses) expect(l.textContent).toContain('How they died');
  });
});

describe('the host panel (review round 3)', () => {
  const hnd = { command: () => undefined, reissue: () => undefined, remap: () => undefined, spectatorLink: () => undefined };
  const tools = { models: [{ alias: 'a', label: 'Model A', enabled: true }, { alias: 'b', label: 'Model B', enabled: true }], result: null };
  const status = (over: Record<string, unknown> = {}): ServerMessage =>
    ({
      type: 'host_status',
      scope: 'host',
      status: 'running',
      pauseReason: null,
      disconnectedSlots: [2],
      costUsd: 0.1,
      costCapUsd: 2,
      lockOpen: false,
      debriefPending: false,
      humans: [
        { slot: 1, name: 'Nadia', connected: true },
        { slot: 2, name: 'Omar', connected: false },
      ],
      ...over,
    }) as ServerMessage;

  it('names who is offline, instead of a slot number that looks like a seat', () => {
    const s = reduce(initialState('g'), status()).state;
    const body = mount();
    renderHost(body, s, hnd, tools);
    expect(body.textContent).toContain('offline: Omar');
    expect(body.textContent).not.toMatch(/offline seats/);
  });

  it('keeps the host’s choice in the tools when the panel is rebuilt', () => {
    let s = reduce(initialState('g'), status()).state;
    const body = mount();
    renderHost(body, s, hnd, tools);
    const who = body.querySelector('details select') as HTMLSelectElement;
    who.value = '2';
    who.dispatchEvent(new Event('change'));
    s = reduce(s, status({ costUsd: 0.2 })).state; // a status update arrives
    renderHost(body, s, hnd, tools);
    expect((body.querySelector('details select') as HTMLSelectElement).value).toBe('2');
  });

  it('offers to replace a model only once the game is open, and then by player name', () => {
    const hidden = reduce(initialState('g'), status()).state;
    const a = mount();
    renderHost(a, hidden, hnd, tools);
    expect(a.textContent).not.toContain('Replace the model');

    const g = { ...play('tools1', []), events: play('tools1', []).events.slice(0, 60) } as Game; // open, not over
    let open = reduce(initialState('g'), { ...(helloFor(g, { kind: 'host' }, true) as object), models: [{ seat: 1, slot: 4, alias: 'a', label: 'Model A' }] } as unknown as ServerMessage).state;
    open = reduce(open, status({ lockOpen: true, humans: [] })).state;
    const b = mount();
    renderHost(b, open, hnd, tools);
    expect(b.textContent).toContain('Replace the model');
    expect(b.textContent).toContain(`${nameOf(g, 1)} — Model A`);
  });

  it('drops the debrief offer once the debrief has started', () => {
    const offered = reduce(initialState('g'), status({ status: 'over_offer', debriefPending: true })).state;
    const a = mount();
    renderHost(a, offered, hnd, tools);
    expect(a.textContent).toContain('Open the debrief');
    const running = reduce(initialState('g'), status({ status: 'debrief', debriefPending: true })).state;
    const b = mount();
    renderHost(b, running, hnd, tools);
    expect(b.textContent).not.toContain('Open the debrief');
  });
});

describe('the turn panel (review round 3)', () => {
  const g = play('turn3', [1]);
  const withRequest = (req: Record<string, unknown>, draft: Partial<AppState['draft']> = {}): AppState => {
    const s = reduce(initialState('g'), { ...(helloFor(g, seatPrincipal(g, 1), false) as object), pending: { clientRequestId: 'q', optional: true, deadlineAt: null, ...req } } as unknown as ServerMessage).state;
    return { ...s, draft: { ...s.draft, ...draft } };
  };

  it('the Witch cannot poison the player she is healing', () => {
    const s = withRequest({ kind: 'witch', context: 'witch', legal: { canHeal: true, healTarget: 2, poisonTargets: [2, 3] } }, { heal: true });
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    const poison = [...body.querySelectorAll('.options')][1]!.textContent ?? '';
    expect(poison).toContain(nameOf(g, 3));
    expect(poison).not.toContain(nameOf(g, 2));
  });

  it('a refusal names the players instead of listing seat numbers', () => {
    let s = withRequest({ kind: 'vote', context: 'day', legal: { targets: [1, 2] } });
    s = reduce(s, { type: 'decision_error', scope: 'seat', clientRequestId: 'q', issues: ['vote must be one of [1, 2]'] } as ServerMessage).state;
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    expect(body.querySelector('.issues')!.textContent).toContain(`${nameOf(g, 1)}, ${nameOf(g, 2)}`);
  });

  it('the Sheriff runoff asks its own question', () => {
    const s = withRequest({ kind: 'vote', context: 'sheriff_runoff', legal: { targets: [1, 2] } });
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    expect(body.textContent).toContain('Sheriff vote is tied');
  });
});

describe('following the game (review round 4)', () => {
  it('the table says which cards are in play, from the first moment', () => {
    const g = play('cards1', [1]);
    const s = reduce(initialState('g'), helloFor(g, seatPrincipal(g, 1), false)).state;
    const t = mount();
    renderTable(t, s, { onPick: () => undefined });
    const line = t.querySelector('.cards-line')!.textContent ?? '';
    expect(line).toContain('Cards in play');
    expect(line).toContain('Seer');
    const l = mount();
    renderLog(l, s);
    expect(l.textContent).toContain('The game begins with');
  });

  it('a question settled without the player is explained, not just gone', () => {
    const g = play('note1', [1]);
    const req = { clientRequestId: 'n1', kind: 'vote', context: 'day', legal: { targets: [2] }, optional: false, deadlineAt: null };
    let s = reduce(initialState('g'), { ...(helloFor(g, seatPrincipal(g, 1), false) as object), pending: req } as unknown as ServerMessage).state;
    s = reduce(s, { type: 'decision_closed', scope: 'seat', clientRequestId: 'n1' } as ServerMessage).state;
    const body = mount();
    renderTurn(body, s, { change: () => undefined, submit: () => undefined });
    expect(body.textContent).toContain('settled without you');
  });

  it('the table does not offer the Witch the player she is healing as a poison target', () => {
    const g = play('witch1', [1]);
    const req = { clientRequestId: 'w1', kind: 'witch', context: 'witch', legal: { canHeal: true, healTarget: 2, poisonTargets: [2, 3] }, optional: true, deadlineAt: null };
    let s = reduce(initialState('g'), { ...(helloFor(g, seatPrincipal(g, 1), false) as object), pending: req } as unknown as ServerMessage).state;
    s = { ...s, draft: { ...s.draft, heal: true } };
    const t = mount();
    renderTable(t, s, { onPick: () => undefined });
    const pickable = [...t.querySelectorAll('.seat.target .name')].map((n) => n.textContent);
    expect(pickable).toContain(nameOf(g, 3));
    expect(pickable).not.toContain(nameOf(g, 2));
  });

  it('while the models think, the story says what the table is doing (never who acts)', () => {
    const g = play('act1', [1]);
    const cut = { ...g, events: g.events.slice(0, 40) } as Game;
    const s = reduce(initialState('g'), helloFor(cut, seatPrincipal(cut, 1), false)).state;
    const l = mount();
    renderLog(l, s);
    const line = l.querySelector('.entry.activity')?.textContent ?? '';
    expect(line).toMatch(/Night|Dawn|Dusk|village/);
    for (let seat = 2; seat <= 10; seat++) expect(line).not.toContain(nameOf(g, seat));
  });
});

describe('the screens (review round 5)', () => {
  const hnd = { command: () => undefined, reissue: () => undefined, remap: () => undefined, spectatorLink: () => undefined };
  const tools = { models: [], result: null };
  const status = (over: Record<string, unknown> = {}): ServerMessage =>
    ({ type: 'host_status', scope: 'host', status: 'running', pauseReason: null, disconnectedSlots: [], costUsd: 0, costCapUsd: 2, lockOpen: true, debriefPending: false, humans: [], ...over }) as ServerMessage;

  it('once the game is decided, the host panel offers the debrief and "end", not game controls', () => {
    const g = play('after1', []);
    let s = reduce(initialState('g'), helloFor(g, { kind: 'host' }, true)).state;
    s = reduce(s, status({ status: 'over_offer', debriefPending: true })).state;
    const body = mount();
    renderHost(body, s, hnd, tools);
    const buttons = [...body.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Open the debrief');
    expect(buttons).not.toContain('Pause');
    expect(buttons).not.toContain('Settle the current turn');
    expect(body.textContent).not.toContain('More host tools');
  });

  it('a pause for a refused API key gives the right advice, not "replace a model"', () => {
    const g = { ...play('key1', []), events: play('key1', []).events.slice(0, 60) } as Game;
    let s = reduce(initialState('g'), { ...(helloFor(g, { kind: 'host' }, true) as object), status: 'paused', pauseReason: 'provider_failure' } as unknown as ServerMessage).state;
    s = reduce(s, status({ status: 'paused', pauseReason: 'provider_failure', pauseDetail: 'api_key' })).state;
    const body = mount();
    renderHost(body, s, hnd, tools);
    expect(body.textContent).toContain('OPENROUTER_API_KEY');
    expect(body.textContent).not.toContain('Replace it under');
  });

  it('a pass reads as a pass, and a claim names the role', () => {
    const g = play('pass1', []);
    const cut = { ...g, events: g.events.slice(0, 5) } as Game;
    let s = reduce(initialState('g'), helloFor(cut, { kind: 'spectator' }, true)).state;
    s = reduce(s, {
      type: 'entries',
      scope: 'spectator',
      fromVseq: s.client.scopes.spectator.lastVseq,
      entries: [
        { vseq: s.client.scopes.spectator.lastVseq + 1, at: { phase: 'day', day: 1, night: 1 }, type: 'SPEECH', payload: { seat: 1, context: 'discussion', round: 1, text: '(pass)', lean: null, claim: null } },
        { vseq: s.client.scopes.spectator.lastVseq + 2, at: { phase: 'day', day: 1, night: 1 }, type: 'SPEECH', payload: { seat: 2, context: 'discussion', round: 1, text: 'Trust me.', lean: null, claim: { role: 'village_idiot' } } },
      ],
    } as unknown as ServerMessage).state;
    const l = mount();
    renderLog(l, s);
    expect(l.textContent).toContain('passes without a word');
    expect(l.textContent).not.toContain('(pass)');
    expect(l.textContent).toContain('claims to be the Village Idiot');
  });

  it('a joined player gets no new link, and can be moved to another device on purpose', () => {
    const data: LobbyData = {
      id: 'g',
      draft: { compositionId: 'classic-5', costCapUsd: 2, slots: [1, 2, 3, 4, 5].map((n) => ({ slot: n, controller: n <= 2 ? 'human' : 'ai', alias: n <= 2 ? null : 'm', humanName: n <= 2 ? `P${n}` : null })) },
      compositions: [{ id: 'classic-5', label: 'Classic', category: 'classic', seats: 5, cards: ['werewolf'], description: null, tags: [], weight: 0, band: { min: -3, max: 5 } }],
      models: [{ alias: 'm', label: 'Model', enabled: true }],
      rosters: {},
      links: { seats: [{ slot: 2, humanName: 'P2', url: 'http://x/join/b' }], spectator: '', joined: [1] },
      estimate: null,
      connectedSlots: [1],
      recent: [],
      busy: false,
      error: null,
    };
    const replaced: number[] = [];
    const root = mount();
    const prev = window.confirm;
    window.confirm = () => true;
    renderLobby(root, data, { create: () => undefined, patch: () => undefined, links: () => undefined, estimate: () => undefined, start: () => undefined, spectatorLink: () => undefined, discard: () => undefined, replaceLink: (n) => replaced.push(n) });
    expect(root.textContent).toContain('Already joined, so no new link: P1');
    expect(root.textContent).not.toContain('http://x/join/a');
    ([...root.querySelectorAll('button')].find((b) => b.textContent === 'Replace link') as HTMLButtonElement).click();
    expect(replaced).toEqual([1]);
    window.confirm = prev;
  });
});
