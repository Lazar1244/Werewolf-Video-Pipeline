import { request, type ServerMessage } from '@ww/client-sdk';
import { h, panel, replace } from './dom';
import { entries, initialState, pending, reduce, view, type AppState, type Draft } from './app';
import { renderTable } from './views/table';
import { renderLog } from './views/log';
import { buildDecision, canSubmit, renderTimer, renderTurn } from './views/turn';
import { renderHost, renderNotes, renderRole, type HostTools } from './views/side';
import { renderLobby, renderWaitingRoom, type Draft as LobbyDraft, type DraftPatch, type LobbyData } from './views/lobby';
import { deathNotice, renderDeath } from './views/death';

/**
 * The browser client. It holds one socket, folds every message into one state, and renders
 * from that state — so what is on screen is exactly what the server allowed this device to know.
 */
const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const gameFromUrl = params.get('game');
let state: AppState = initialState(gameFromUrl);
let socket: WebSocket | null = null;
let lastTurnKey: string | null = null;
let lastLogKey = '';
let lastLobbyKey = '';
let lastHostKey = '';
let retries = 0;
let retryTimer: number | undefined;
let heartbeat: number | undefined;
let lastHeard = 0;
/** Set when the server closes the socket for good (not our game, or no seat on it). */
let refused: string | null = null;
let hostResult: HostTools['result'] = null;
let commandTimer: number | undefined;
const OFFLINE_ANSWER = 'You are offline, so your answer was not sent. It is kept: press Send again once you are reconnected.';
const OFFLINE_COMMAND = 'You are offline: that command was not sent.';
/** An "you are offline" message stops being true the moment the connection is back. */
const clearOfflineError = (s: AppState): AppState => (s.error === OFFLINE_ANSWER || s.error === OFFLINE_COMMAND ? { ...s, error: null } : s);

const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private browsing: nothing is remembered, which is fine
    }
  },
  remove: (k: string): void => {
    try {
      localStorage.removeItem(k);
    } catch {
      // as above
    }
  },
};

/**
 * The rejoin code arrives once, in the fragment of the page a join link lands on (the fragment
 * is never sent to a server). It is kept on this device only, and taken out of the address bar.
 */
function takeRejoinCode(): void {
  const m = /rejoin=([0-9A-F]{6})/i.exec(location.hash);
  if (!m || !gameFromUrl) return;
  store.set(`ww.rejoin.${gameFromUrl}`, m[1]!.toUpperCase());
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
const rejoinCode = (): string | null => (state.gameId ? store.get(`ww.rejoin.${state.gameId}`) : null);

const lobby: LobbyData = {
  id: state.gameId,
  draft: null,
  compositions: [],
  models: [],
  rosters: {},
  links: null,
  estimate: null,
  connectedSlots: [],
  recent: [],
  busy: false,
  error: null,
};

/* ---------------- shell ---------------- */

const phaseEl = h('div', { class: 'phase' }, h('span', { class: 'orb' }), h('span', { class: 'label', text: 'Connecting' }));
const chips = h('div', { class: 'row' });
const gamesButton = h('button', { class: 'ghost small', onclick: () => leaveGame() }, 'All games');
const topbar = h('header', { class: 'topbar' }, phaseEl, h('div', { class: 'spacer' }), chips, gamesButton);

const tablePanel = panel('The table', 'table-panel');
const logPanel = panel('What happened', 'log-panel');
const turnPanel = panel('Your turn', 'turn');
const rolePanel = panel('Your card', 'role-card');
const notesPanel = panel('Your notes', 'notes-panel');
const hostPanel = panel('Host controls', 'host-panel');
const timerBar = h('div', { class: 'timer' });

const errorBar = h('div', { class: 'banner danger', style: 'display:none' });
const left = h('div', { class: 'col left' }, tablePanel.root, rolePanel.root);
const centre = h('div', { class: 'col centre' }, logPanel.root);
const right = h('div', { class: 'col right' }, turnPanel.root, notesPanel.root, hostPanel.root);
const main = h('div', { class: 'main' }, left, centre, right);
const gameScreen = h('div', {}, topbar, errorBar, main);
const lobbyScreen = h('div', { class: 'lobby' });
/** "You died": over everything, outside the game screen so a re-render never drops it. */
const deathOverlay = h('div', {});
/** What the death notice on screen says (null when none is shown). */
let deathKey: string | null = null;
let focusBeforeDeath: Element | null = null;

turnPanel.root.insertBefore(timerBar, turnPanel.body);
tablePanel.body.className = 'seats';
logPanel.body.className = 'log';

/** The host goes back to the list of games (and to "New game"). */
function leaveGame(): void {
  store.remove('ww.game');
  location.assign('/');
}

/* ---------------- connection ---------------- */

function connect(gameId: string): void {
  store.set('ww.game', gameId);
  const url = `${location.origin.replace(/^http/, 'ws')}/ws?game=${encodeURIComponent(gameId)}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retries = 0;
    refused = null;
    lastHeard = Date.now();
    state = clearOfflineError({ ...state, connected: true });
    // notes written while offline were never saved: send them now
    if (!state.notesSaved && state.isSeat) saveNotes(state.notes);
    render();
  };
  ws.onclose = (ev) => {
    if (socket !== ws) return; // an older socket we already replaced
    window.clearInterval(heartbeat);
    state = { ...state, connected: false };
    // 1008 is the server saying this device has no business on this game: retrying cannot help
    if (ev.code === 1009) {
      // a message was too big for the server: sending it again would only loop
      state = { ...state, notesSaved: true, error: 'Your notes are too long to save: shorten them a little.' };
    }
    if (ev.code === 1008) {
      refused = ev.reason === 'not a principal of this game' || !ev.reason ? 'This device is not part of that game.' : ev.reason;
      store.remove('ww.game');
      render();
      return;
    }
    render();
    // back off so a server that is down is not hammered, but keep trying: a LAN drops out
    const wait = Math.min(15_000, 1000 * 2 ** Math.min(retries++, 4));
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (state.gameId) connect(state.gameId);
    }, wait);
  };
  ws.onmessage = (ev) => {
    lastHeard = Date.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    const before = pending(state)?.clientRequestId;
    const { state: next, resync } = reduce(state, msg);
    state = next;
    // a new question, whether it arrives on its own or inside a snapshot after a reload
    const now = pending(state)?.clientRequestId;
    if (now && now !== before && (msg.type === 'decision_request' || msg.type === 'hello')) announceTurn();
    if (msg.type === 'command_result') {
      window.clearTimeout(commandTimer);
      commandTimer = window.setTimeout(() => {
        state = { ...state, client: { ...state.client, commandResult: null } };
        render();
      }, 8000);
    }
    if (resync) send({ type: 'resync' });
    render();
  };
  // A half-open socket on a LAN never fires onclose. Ping now and then; if nothing at all has
  // come back for a while, the connection is dead: close it, and the retry logic takes over.
  window.clearInterval(heartbeat);
  heartbeat = window.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastHeard > 45_000) {
      ws.close();
      return;
    }
    send({ type: 'ping' });
  }, 15_000);
}

/** Make it obvious that the game is waiting for this person, even in a background tab. */
function announceTurn(): void {
  document.title = 'Your turn — Werewolf';
  // on one column the question may be far above; bring it into view, unless they are writing notes
  const writing = document.activeElement instanceof HTMLTextAreaElement && !turnPanel.root.contains(document.activeElement);
  if (!writing && window.matchMedia?.('(max-width: 1100px)').matches) turnPanel.root.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  turnPanel.root.animate?.([{ boxShadow: '0 0 0 0 rgba(216,166,87,0.0)' }, { boxShadow: '0 0 0 6px rgba(216,166,87,0.35)' }, { boxShadow: '0 0 0 0 rgba(216,166,87,0.0)' }], { duration: 900, iterations: 2 });
}

/** Returns false when the socket is not open, so the caller can leave the work undone. */
function send(msg: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

const api = <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => request<T>(path, init);

/* ---------------- rendering ---------------- */

function render(): void {
  const v = view(state);
  const started = !!v && entries(state).length > 0;
  if (!started) {
    if (root.firstChild !== lobbyScreen) {
      replace(root, lobbyScreen);
      lastLobbyKey = '';
    }
    if (state.isHost) {
      const data: LobbyData = { ...lobby, connectedSlots: state.lobby?.connectedSlots ?? [], openLinks: state.lobby?.openLinks ?? [], error: state.error ?? lobby.error };
      // only rebuild when something the host can see has changed
      const key = JSON.stringify([data.draft, data.links, data.estimate, data.connectedSlots, data.openLinks, data.error, data.busy, data.recent.length, data.compositions.length, data.spectatorUrl]);
      if (key !== lastLobbyKey) {
        lastLobbyKey = key;
        renderLobby(lobbyScreen, data, lobbyHandlers);
      }
    } else {
      renderWaitingRoom(lobbyScreen, state.lobby?.slot ?? null, state.lobby?.connectedSlots ?? [], { refused, waiting: !!state.gameId && !refused, rejoinCode: rejoinCode(), hostLogin, error: state.error });
      lastLobbyKey = '';
    }
    return;
  }
  if (root.firstChild !== gameScreen) replace(root, gameScreen);

  // top bar
  const phase = v!.result ? 'over' : v!.phase === 'night' || v!.phase === 'dawn' ? 'night' : 'day';
  phaseEl.className = `phase ${phase}`;
  (phaseEl.querySelector('.label') as HTMLElement).textContent = v!.result
    ? `Game over — ${v!.result.winner === 'draw' ? 'a draw' : `${v!.result.winner} wins`}`
    : v!.phase === 'night'
      ? `Night ${v!.night}`
      : v!.phase === 'dawn'
        ? `Dawn ${v!.night}`
        : v!.phase === 'dusk'
          ? `Dusk ${v!.day}`
          : `Day ${v!.day}`;

  const alive = v!.table.filter((p) => p.alive).length;
  replace(
    chips,
    h('span', { class: 'chip', text: `${alive} alive of ${v!.table.length}` }),
    state.client.paused ? h('span', { class: 'chip warn', text: `paused — ${state.client.paused.reason.replace(/_/g, ' ')}` }) : null,
    state.client.status === 'aborted' ? h('span', { class: 'chip danger', text: 'the host ended this game' }) : null,
    state.connected ? null : h('span', { class: 'chip danger', text: 'reconnecting…' }),
    h('span', { class: 'chip', text: revealChip() }),
  );
  gamesButton.style.display = state.isHost ? '' : 'none';
  // a host who is not playing needs their controls first on a phone, not at the bottom
  main.classList.toggle('hosting', state.isHost && !state.isSeat);

  // a message the server refused to accept, until the player waves it away
  errorBar.style.display = state.error ? '' : 'none';
  if (state.error) replace(errorBar, h('span', { text: state.error }), h('button', { class: 'ghost', onclick: dismissError }, 'Dismiss'));
  else replace(errorBar); // gone for good, not just hidden (a screen reader would still read it)

  renderTable(tablePanel.body, state, { onPick: pick });
  // the log only changes when entries do; rebuilding it on every keystroke would drop selections
  const logKey = `${entries(state).length}:${String(state.client.lockOpen)}:${String(v!.me?.seat)}:${state.client.models.length}:${pending(state)?.clientRequestId ?? ''}:${state.client.paused?.reason ?? ''}:${state.client.status}`;
  if (logKey !== lastLogKey) {
    lastLogKey = logKey;
    renderLog(logPanel.body, state);
  }
  renderRole(rolePanel.body, state, rejoinCode());

  // the turn panel is only rebuilt for a new request or a changed choice, so typing is never interrupted
  const req = pending(state);
  const d = state.draft;
  const turnKey = req
    ? `${req.clientRequestId}:${d.sent ? 1 : 0}:${state.issues.join('|')}:${d.lean}:${String(d.target)}:${d.multi.join(',')}:${d.choice}:${d.run}:${d.heal}:${d.ready}:${d.claimRole}:${String(d.touched)}`
    : `none:${String(state.isSeat)}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    renderTurn(turnPanel.body, state, { change: changeDraft, submit: submitDraft });
  }
  turnPanel.root.style.display = state.isSeat || req ? '' : 'none';
  if (!req) document.title = 'Werewolf';
  renderTimer(timerBar, req, state.timing);

  notesPanel.root.style.display = state.isSeat ? '' : 'none';
  if (state.isSeat) renderNotes(notesPanel.body, state, saveNotes);
  hostPanel.root.style.display = state.isHost ? '' : 'none';
  if (state.isHost) {
    const tools = hostTools();
    const key = JSON.stringify([state.client.host, state.client.paused, state.client.status, state.client.lockOpen, state.client.commandResult, state.client.models, hostResult]);
    if (key !== lastHostKey) {
      lastHostKey = key;
      renderHost(hostPanel.body, state, hostHandlers, tools);
    }
  }
  showDeath();
}

/**
 * The moment this player's own seat falls, say so, big and red, once: closing it is remembered
 * on this device, so a reload does not bring it back.
 */
function showDeath(): void {
  const n = deathNotice(state);
  const seen = n && state.gameId ? store.get(`ww.died.${state.gameId}`) === String(n.seat) : true;
  if (!n || seen) {
    if (deathKey !== null) closeDeath(false);
    return;
  }
  const key = JSON.stringify(n);
  document.title = 'You died — Werewolf'; // render() resets the title on every pass
  if (key === deathKey) return;
  const fresh = deathKey === null;
  deathKey = key;
  renderDeath(deathOverlay, n, fresh, () => closeDeath(true));
  if (fresh) {
    focusBeforeDeath = document.activeElement;
    document.body.appendChild(deathOverlay);
    deathOverlay.querySelector('button')?.focus();
  }
}

function closeDeath(remember: boolean): void {
  const n = deathNotice(state);
  if (remember && n && state.gameId) store.set(`ww.died.${state.gameId}`, String(n.seat));
  deathKey = null;
  deathOverlay.remove();
  if (document.title === 'You died — Werewolf') document.title = pending(state) ? 'Your turn — Werewolf' : 'Werewolf';
  // a last action waiting (a Hunter's shot): straight to it
  if (pending(state)) {
    turnPanel.root.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    turnPanel.root.querySelector<HTMLElement>('button, textarea, select, input')?.focus();
  } else if (focusBeforeDeath instanceof HTMLElement && focusBeforeDeath.isConnected) focusBeforeDeath.focus();
  focusBeforeDeath = null;
}

/** Says truthfully what this screen is showing. */
function revealChip(): string {
  if (!state.client.lockOpen) return 'roles hidden';
  if (state.isSeat && !state.client.scopes.spectator.view) return 'your own view';
  return 'everything revealed';
}

/** What the host's tools need beyond the live state: the models that could be put on a seat. */
function hostTools(): HostTools {
  return { models: lobby.models, result: hostResult };
}

/** The host signing in from another device on the LAN, with HOST_TOKEN. */
function hostLogin(token: string): void {
  void (async () => {
    try {
      await api('/api/host/login', { method: 'POST', body: { token } });
      location.assign('/');
    } catch (e) {
      state = { ...state, error: (e as Error).message };
      lastLobbyKey = '';
      render();
    }
  })();
}

/* ---------------- interaction ---------------- */

function changeDraft(patch: Partial<Draft>): void {
  state = { ...state, draft: { ...state.draft, ...patch } };
  // a text change must not rebuild the panel (it would move the caret), so only re-render the rest
  if (patch.text === undefined) render();
  else renderTable(tablePanel.body, state, { onPick: pick });
}

function pick(seat: number): void {
  const req = pending(state);
  if (!req) return;
  if (req.kind === 'speech') changeDraft({ lean: state.draft.lean === seat ? null : seat });
  else if (req.kind === 'multi' || req.kind === 'pair') {
    const has = state.draft.multi.includes(seat);
    const max = ((req.legal ?? {}) as { max?: number }).max ?? (req.kind === 'pair' ? 2 : 10);
    changeDraft({ multi: has ? state.draft.multi.filter((x) => x !== seat) : [...state.draft.multi, seat].slice(-max) });
  } else changeDraft({ target: seat, touched: true });
}

function dismissError(): void {
  state = { ...state, error: null };
  render();
}

function submitDraft(): void {
  const req = pending(state);
  if (!req || state.draft.sent) return;
  // an optional request is still answered with something the engine accepts (the Skip button
  // fills in the "nothing" answer first), so this is never bypassed
  if (!canSubmit(state)) return;
  if (!send({ type: 'submit_decision', scope: 'seat', clientRequestId: req.clientRequestId, decision: buildDecision(state) })) {
    // not connected: the answer stays here, ready to send again once the connection is back
    state = { ...state, error: OFFLINE_ANSWER };
    render();
    return;
  }
  document.title = 'Werewolf';
  state = clearOfflineError({ ...state, turnNote: null, draft: { ...state.draft, sent: true } });
  render();
}

let notesTimer: number | undefined;
function saveNotes(text: string): void {
  state = { ...state, notes: text, notesSaved: false };
  renderNotes(notesPanel.body, state, saveNotes);
  window.clearTimeout(notesTimer);
  notesTimer = window.setTimeout(() => {
    if (!send({ type: 'notes_update', scope: 'seat', text })) return; // still unsaved; sent again on reconnect
    state = { ...state, notesSaved: true };
    renderNotes(notesPanel.body, state, saveNotes);
  }, 600);
}

const hostHandlers = {
  spectatorLink: () => {
    void (async () => {
      try {
        const res = await api<{ url: string }>(`/api/games/${state.gameId}/spectator-link`, { method: 'POST' });
        hostResult = { ok: true, text: 'A spectator link for this game (anyone can open it, as often as they like):', url: res.url };
      } catch (e) {
        hostResult = { ok: false, text: (e as Error).message };
      }
      render();
    })();
  },
  command: (cmd: Record<string, unknown>) => {
    if (!send({ type: 'host_command', scope: 'host', command: cmd })) {
      state = { ...state, error: OFFLINE_COMMAND };
      render();
    }
  },
  reissue: (slot: number, code: string | null) => {
    void (async () => {
      try {
        const res = await api<{ url: string }>(`/api/games/${state.gameId}/reissue-link`, { method: 'POST', body: { slot, ...(code ? { rejoinCode: code } : {}) } });
        hostResult = { ok: true, text: `New link for slot ${slot}. Send it to that player; their old one no longer works.`, url: res.url };
      } catch (e) {
        hostResult = { ok: false, text: (e as Error).message };
      }
      render();
    })();
  },
  remap: (slot: number, alias: string) => {
    void (async () => {
      try {
        await api(`/api/games/${state.gameId}/remap-seat`, { method: 'POST', body: { slot, alias } });
        const seat = state.client.models.find((m) => m.slot === slot)?.seat;
        const who = seat ? (view(state)?.table[seat - 1]?.name ?? `seat ${seat}`) : `slot ${slot}`;
        hostResult = { ok: true, text: `${who} is now played by ${lobby.models.find((m) => m.alias === alias)?.label ?? alias}.` };
      } catch (e) {
        hostResult = { ok: false, text: (e as Error).message };
      }
      render();
    })();
  },
};

/* ---------------- lobby ---------------- */

/** The lobby changes still on their way to the server, in order (see `patch`). */
let lobbyPatches: Promise<void> = Promise.resolve();

const lobbyHandlers = {
  create: (compositionId: string, aliases: string[], manual: boolean) => {
    void (async () => {
      try {
        lobby.busy = true;
        const res = await api<{ id: string; draft: LobbyDraft }>('/api/lobbies', { method: 'POST', body: { compositionId, aliases, manual } });
        lobby.id = res.id;
        lobby.draft = res.draft;
        lobby.error = null;
        state = { ...state, gameId: res.id };
        history.replaceState(null, '', `/?game=${encodeURIComponent(res.id)}`);
        connect(res.id);
      } catch (e) {
        lobby.error = (e as Error).message;
      } finally {
        lobby.busy = false;
        render();
      }
    })();
  },
  patch: (change: DraftPatch) => {
    // one change at a time, each built on the draft the one before it left (quick edits never undo each other)
    lobbyPatches = lobbyPatches.then(async () => {
      if (!lobby.draft) return;
      const patch = typeof change === 'function' ? change(lobby.draft) : change;
      try {
        const res = await api<{ draft: LobbyDraft }>(`/api/lobbies/${lobby.id}`, { method: 'PATCH', body: patch });
        // a different table, other seats or a different day length cost differently: the old estimate no longer holds
        if (patch.slots || patch.compositionId || patch.rulesOverride || patch.manualDeal !== undefined) lobby.estimate = null;
        lobby.draft = res.draft;
        lobby.error = null;
      } catch (e) {
        lobby.error = (e as Error).message;
      }
      render();
    });
  },
  links: () => {
    void (async () => {
      try {
        lobby.links = await api(`/api/lobbies/${lobby.id}/links`, { method: 'POST' });
        lobby.error = null;
      } catch (e) {
        lobby.error = (e as Error).message;
      }
      render();
    })();
  },
  estimate: () => {
    void (async () => {
      try {
        lobby.estimate = await api(`/api/lobbies/${lobby.id}/estimate`);
        lobby.error = null;
      } catch (e) {
        lobby.error = (e as Error).message;
      }
      render();
    })();
  },
  spectatorLink: () => {
    void (async () => {
      try {
        lobby.spectatorUrl = (await api<{ url: string }>(`/api/games/${lobby.id}/spectator-link`, { method: 'POST' })).url;
        lobby.error = null;
      } catch (e) {
        lobby.error = (e as Error).message;
      }
      render();
    })();
  },
  replaceLink: (slot: number) => {
    void (async () => {
      try {
        const res = await api<{ url: string }>(`/api/lobbies/${lobby.id}/replace-link`, { method: 'POST', body: { slot } });
        const who = lobby.draft?.slots.find((s) => s.slot === slot)?.humanName ?? `seat ${slot}`;
        const others = (lobby.links?.seats ?? []).filter((l) => l.slot !== slot);
        lobby.links = {
          seats: [...others, { slot, humanName: who, url: res.url }].sort((a, b) => a.slot - b.slot),
          spectator: lobby.links?.spectator ?? '',
          joined: (lobby.links?.joined ?? []).filter((n) => n !== slot),
        };
        lobby.error = null;
      } catch (e) {
        lobby.error = (e as Error).message;
      }
      render();
    })();
  },
  discard: () => {
    void (async () => {
      try {
        await api(`/api/lobbies/${lobby.id}/discard`, { method: 'POST' });
        leaveGame();
      } catch (e) {
        lobby.error = (e as Error).message;
        render();
      }
    })();
  },
  start: (force: boolean) => {
    void (async () => {
      try {
        lobby.busy = true;
        render();
        await api(`/api/lobbies/${lobby.id}/start`, { method: 'POST', body: { force } });
        lobby.error = null;
      } catch (e) {
        lobby.error = (e as Error).message;
      } finally {
        lobby.busy = false;
        render();
      }
    })();
  },
};

/* ---------------- boot ---------------- */

async function boot(): Promise<void> {
  takeRejoinCode();
  // the host's browser can read the lobby options; a player's cannot, and does not need to
  try {
    const [comps, models, rosters] = await Promise.all([
      api<{ compositions: LobbyData['compositions'] }>('/api/compositions'),
      api<{ profiles: LobbyData['models'] }>('/api/models'),
      api<{ rosters: Record<string, string[]> }>('/api/rosters'),
    ]);
    lobby.compositions = comps.compositions;
    lobby.models = models.profiles;
    lobby.rosters = rosters.rosters;
    state = { ...state, isHost: true };
    try {
      const games = await api<{ games: LobbyData['recent'] }>('/api/games');
      lobby.recent = games.games;
    } catch {
      // the list is a convenience; the lobby works without it
    }
  } catch {
    // not the host: this device just plays or watches
  }
  // The host opening "/" gets the list of games and "New game". A player who opens "/" again
  // goes back to the game their link put them in.
  if (!state.gameId && !state.isHost) state = { ...state, gameId: store.get('ww.game') };
  lobby.id = state.gameId;
  if (state.gameId) {
    if (state.isHost) {
      try {
        const draft = await api<{ draft: LobbyDraft }>(`/api/lobbies/${state.gameId}`);
        lobby.draft = draft.draft;
      } catch {
        // an old game without a draft: the host tools just have nothing to list
      }
    }
    connect(state.gameId);
  }
  render();
  setInterval(() => renderTimer(timerBar, pending(state), state.timing), 1000);
}

void boot();
