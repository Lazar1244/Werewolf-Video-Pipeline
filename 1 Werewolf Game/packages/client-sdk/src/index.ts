import { project, reduceView, type GameView, type ViewEntry } from '@ww/projector';
import type { ClientMessage, ClientRequest, HostCommand, Principal, Scope, SeatModelInfo, ServerMessage } from '@ww/shared';

/**
 * Typed client for the server (ARCHITECTURE.md §11). The web UI talks to the server only
 * through this: `applyMessage` folds every WebSocket message into one state, and `request`
 * makes the REST calls.
 *
 * One socket can carry several principals at once (host-player mode, §9.1), and each has its
 * own entry feed with its own `vseq`. The state therefore keeps one view **per scope**.
 */
export { project, reduceView };
export type { GameView, ViewEntry, ClientRequest, Principal, Scope, ServerMessage, ClientMessage, HostCommand, SeatModelInfo };

export interface ScopeState {
  principal: Principal | null;
  entries: ViewEntry[];
  lastVseq: number;
  view: GameView | null;
}

export interface ClientState {
  gameId: string | null;
  status: string;
  lockOpen: boolean;
  /** One feed per scope the socket holds: host, seat, spectator. */
  scopes: Record<Scope, ScopeState>;
  pending: ClientRequest | null;
  notes: string;
  /** Set whenever the server says the game is paused — by a `paused` message or by a snapshot. */
  paused: { reason: string } | null;
  host: Extract<ServerMessage, { type: 'host_status' }> | null;
  lobby: unknown | null;
  /** Which model played which seat; empty until the game is open to this viewer. */
  models: SeatModelInfo[];
  /** What the server said about the host's last command. */
  commandResult: { cmd: string; ok: boolean; message: string } | null;
}

const emptyScope = (): ScopeState => ({ principal: null, entries: [], lastVseq: 0, view: null });

export const emptyState = (): ClientState => ({
  gameId: null,
  status: 'lobby',
  lockOpen: false,
  scopes: { host: emptyScope(), seat: emptyScope(), spectator: emptyScope() },
  pending: null,
  notes: '',
  paused: null,
  host: null,
  lobby: null,
  models: [],
  commandResult: null,
});

/** The seat feed if this client holds one, else the spectator feed, else the host feed. */
export function primaryScope(state: ClientState): Scope {
  if (state.scopes.seat.principal) return 'seat';
  if (state.scopes.spectator.principal) return 'spectator';
  return 'host';
}

/** A snapshot or a status message says where the game stands; `paused` follows from it. */
const pausedFrom = (status: string, reason: string | null | undefined): ClientState['paused'] => (status === 'paused' ? { reason: reason ?? 'host' } : null);

/**
 * Fold one server message into the client state. A gap in `vseq` for that scope means entries
 * were missed, so the caller sends `resync` (the second return value says so).
 */
export function applyMessage(state: ClientState, msg: ServerMessage): { state: ClientState; needsResync: boolean } {
  const withScope = (scope: Scope, next: ScopeState): ClientState => ({ ...state, scopes: { ...state.scopes, [scope]: next } });
  switch (msg.type) {
    case 'hello': {
      const seat = msg.principal.kind === 'seat' ? msg.principal.seat : null;
      const entries = msg.entries as ViewEntry[];
      const next: ScopeState = { principal: msg.principal, entries, lastVseq: msg.lastVseq, view: (msg.view as GameView) ?? reduceView(entries, seat) };
      const s = withScope(msg.scope, next);
      return {
        state: {
          ...s,
          gameId: msg.gameId,
          status: msg.status,
          lockOpen: msg.lockOpen,
          notes: msg.notes ?? s.notes,
          pending: msg.scope === 'seat' ? (msg.pending ?? null) : s.pending,
          // a device that connects (or reconnects) during a pause must know it is paused
          paused: pausedFrom(msg.status, msg.pauseReason),
          models: msg.models ?? s.models,
        },
        needsResync: false,
      };
    }
    case 'entries': {
      const scope = state.scopes[msg.scope];
      if (msg.fromVseq > scope.lastVseq) return { state, needsResync: true }; // a gap: ask for a snapshot
      const fresh = (msg.entries as ViewEntry[]).filter((e) => e.vseq > scope.lastVseq);
      if (fresh.length === 0) return { state, needsResync: false };
      const entries = [...scope.entries, ...fresh];
      const seat = scope.principal?.kind === 'seat' ? scope.principal.seat : null;
      return { state: withScope(msg.scope, { ...scope, entries, lastVseq: entries.at(-1)!.vseq, view: reduceView(entries, seat) }), needsResync: false };
    }
    case 'decision_request':
      return { state: { ...state, pending: msg.request }, needsResync: false };
    case 'decision_accepted':
    case 'decision_closed':
      // answered, or settled without this player: either way the question is gone
      return { state: { ...state, pending: state.pending?.clientRequestId === msg.clientRequestId ? null : state.pending }, needsResync: false };
    case 'paused':
      return { state: { ...state, paused: { reason: msg.reason }, status: 'paused' }, needsResync: false };
    case 'resumed':
      // back to where the game was: running, or the debrief if it was paused during one
      return { state: { ...state, paused: null, status: msg.status ?? 'running' }, needsResync: false };
    case 'lock_opened':
      return { state: { ...state, lockOpen: true }, needsResync: false };
    case 'game_over':
      return { state: { ...state, status: 'over', pending: null }, needsResync: false };
    case 'aborted':
      return { state: { ...state, status: 'aborted', paused: null, pending: null }, needsResync: false };
    case 'host_status':
      return { state: { ...state, host: msg, status: msg.status, lockOpen: msg.lockOpen, paused: pausedFrom(msg.status, msg.pauseReason) }, needsResync: false };
    case 'lobby_state':
      return { state: { ...state, lobby: msg.lobby }, needsResync: false };
    case 'command_result':
      return { state: { ...state, commandResult: { cmd: msg.cmd, ok: msg.ok, message: msg.message } }, needsResync: false };
    default:
      return { state, needsResync: false };
  }
}

/** A REST error with the server's own words, for showing to a person. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * One REST call. A body is sent as JSON; a call without one sends no `Content-Type`, because
 * the server rightly refuses an empty body that claims to be JSON. Errors carry the server's
 * message (`error`, or a framework's `message`), never a bare status line.
 */
export async function request<T>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; fetchImpl?: typeof fetch } = {}): Promise<T> {
  const doFetch = init.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: init.method ?? 'GET',
    headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const j = json as { error?: unknown; message?: unknown };
    const said = typeof j.message === 'string' && (typeof j.error !== 'string' || j.error === res.statusText) ? j.message : typeof j.error === 'string' ? j.error : `request failed (${res.status})`;
    throw new ApiError(said, res.status);
  }
  return json as T;
}
