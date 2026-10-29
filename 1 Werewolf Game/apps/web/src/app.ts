import { applyMessage, emptyState, primaryScope, type ClientRequest, type ClientState, type GameView, type ServerMessage } from '@ww/client-sdk';

/**
 * The browser's view of one game: the projected state from the server plus the few things
 * that only exist on this device (the answer being written, the notes, the connection).
 */
export interface AppState {
  gameId: string | null;
  connected: boolean;
  client: ClientState;
  /** Set once the server greets this socket as the host. */
  isHost: boolean;
  isSeat: boolean;
  /** The answer being composed for the current request. */
  draft: Draft;
  notes: string;
  notesSaved: boolean;
  issues: string[];
  /** The last thing the server complained about, shown until the player dismisses it. */
  error: string | null;
  /** Lobby snapshot before the game starts. */
  lobby: LobbyInfo | null;
  /**
   * The countdown for the open request, measured on this device: the server says how long is
   * left, so a phone whose clock is wrong still counts down correctly. `deadline` is null while
   * the game is paused.
   */
  timing: { id: string; totalMs: number; deadline: number | null } | null;
  /** A short note for the player about their last question (e.g. it ran out of time). */
  turnNote: string | null;
}

export interface Draft {
  requestId: string | null;
  text: string;
  target: number | null | 'abstain';
  /** True once the player has actually chosen a target, so "nobody" is a choice and not a default. */
  touched: boolean;
  choice: string | null;
  multi: number[];
  lean: number | null;
  /** A Challenge (ruleset §9.2) in this discussion speech, or null. */
  challenge: number | null;
  claimRole: string | null;
  claimResult: string;
  heal: boolean;
  ready: boolean;
  run: boolean | null;
  sent: boolean;
}

export interface LobbyInfo {
  gameId: string;
  slot: number | null;
  connectedSlots: number[];
  /** (Host only) seats with a link that was sent but not opened yet. */
  openLinks?: number[];
}

export const emptyDraft = (): Draft => ({
  requestId: null,
  text: '',
  target: null,
  touched: false,
  choice: null,
  multi: [],
  lean: null,
  challenge: null,
  claimRole: null,
  claimResult: '',
  heal: false,
  ready: false,
  run: null,
  sent: false,
});

export const initialState = (gameId: string | null): AppState => ({
  gameId,
  connected: false,
  client: emptyState(),
  isHost: false,
  isSeat: false,
  draft: emptyDraft(),
  notes: '',
  notesSaved: true,
  issues: [],
  error: null,
  lobby: null,
  timing: null,
  turnNote: null,
});

/**
 * Whether this device reads the whole game: a player once the game is open to them (every
 * human is out, or it is over) also holds the spectator feed, and reads the story from it.
 */
const readsSpectatorFeed = (s: AppState): boolean => primaryScope(s.client) === 'seat' && !!s.client.scopes.spectator.view && s.client.lockOpen;

/**
 * The view this device should show: its own seat's if it has one, else spectator/host. A player
 * whose game is open sees the spectator's table and story, still with their own card on it.
 */
export function view(s: AppState): GameView | null {
  if (readsSpectatorFeed(s)) return { ...s.client.scopes.spectator.view!, me: s.client.scopes.seat.view?.me ?? null };
  return s.client.scopes[primaryScope(s.client)].view;
}
export const entries = (s: AppState) => (readsSpectatorFeed(s) ? s.client.scopes.spectator.entries : s.client.scopes[primaryScope(s.client)].entries);
export const pending = (s: AppState): ClientRequest | null => s.client.pending;

/** Start (or refresh) the countdown for a request from what the server says is left. */
function timingFor(prev: AppState['timing'], req: ClientRequest, now: number): AppState['timing'] {
  const left = req.remainingMs ?? (req.deadlineAt === null ? null : Math.max(0, req.deadlineAt - now));
  const deadline = req.deadlineAt === null || left === null ? null : now + left;
  // the bar's full length is the time the request was given (the same after a reload)
  const totalMs = req.totalMs ?? (prev?.id === req.clientRequestId ? prev.totalMs : Math.max(1000, left ?? req.remainingMs ?? 180_000));
  return { id: req.clientRequestId, totalMs, deadline };
}

/** Fold a server message into the app state (the game part is the client-sdk's job). */
export function reduce(s: AppState, msg: ServerMessage, now = Date.now()): { state: AppState; resync: boolean } {
  const { state: client, needsResync } = applyMessage(s.client, msg);
  const next: AppState = { ...s, client };
  switch (msg.type) {
    case 'hello':
      next.gameId = msg.gameId;
      if (msg.principal.kind === 'host') next.isHost = true;
      if (msg.principal.kind === 'seat') next.isSeat = true;
      if (msg.notes !== undefined && (s.notesSaved || !s.notes)) next.notes = msg.notes;
      if (msg.scope === 'seat') {
        if (msg.pending && msg.pending.clientRequestId !== s.draft.requestId) {
          // a new request replaces whatever was half-written for an older one
          next.draft = { ...emptyDraft(), requestId: msg.pending.clientRequestId };
        } else if (msg.pending) {
          // the server is still waiting for this request, so whatever we "sent" never arrived:
          // keep the answer and let the player send it again
          next.draft = { ...s.draft, sent: false };
        }
        next.timing = msg.pending ? timingFor(s.timing, msg.pending, now) : null;
      }
      break;
    case 'decision_request':
      // the same request can be delivered again (a reconnect, a pause that re-arms the clock):
      // that must not wipe an answer already being written
      if (msg.request.clientRequestId !== s.draft.requestId) next.draft = { ...emptyDraft(), requestId: msg.request.clientRequestId };
      next.issues = [];
      // a note about the last question stays until the player has read it and answered this one
      next.timing = timingFor(s.timing, msg.request, now);
      break;
    case 'decision_closed':
      if (s.timing?.id === msg.clientRequestId) next.timing = null;
      // the question did not just vanish: say why
      if (s.client.pending?.clientRequestId === msg.clientRequestId) next.turnNote = 'That question was settled without you (the time ran out or the host moved the game on), so the default answer was used.';
      break;
    case 'decision_error':
      if (msg.issues.includes('not_waiting_for_this')) {
        // the server had already settled this question without us: it is simply gone
        next.client = { ...next.client, pending: next.client.pending?.clientRequestId === msg.clientRequestId ? null : next.client.pending };
        next.timing = null;
        next.issues = [];
        break;
      }
      next.issues = msg.issues;
      next.draft = { ...next.draft, sent: false };
      break;
    case 'decision_accepted':
      next.issues = [];
      next.draft = { ...next.draft, sent: true };
      break;
    case 'lobby_state':
      next.lobby = msg.lobby as LobbyInfo;
      next.gameId = (msg.lobby as LobbyInfo).gameId ?? s.gameId;
      break;
    case 'error':
      next.error = msg.message;
      break;
    case 'aborted':
      next.turnNote = null; // the top bar says the host ended the game; no misleading note
      break;
    default:
      break;
  }
  return { state: next, resync: needsResync };
}
