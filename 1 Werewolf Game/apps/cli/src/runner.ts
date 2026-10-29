import type { PromptPack } from '@ww/context';
import type { EngineState } from '@ww/engine';
import { MockProvider, OpenRouterClient, type CatalogEntry, type LLMProvider } from '@ww/llm';
import { GameOrchestrator, type Env } from '@ww/server';
import type { EngineEvent, GameSnapshot, ModelProfile } from '@ww/shared';
import type { Store } from '@ww/store';
import { bold, green, printEvents, yellow, type PrintOptions } from './print';

export interface RunOptions {
  env: Env;
  store: Store;
  gameId: string;
  snapshot: GameSnapshot;
  entries: Map<string, CatalogEntry>;
  pack: PromptPack;
  print: PrintOptions;
  /** Answer from the schema instead of calling OpenRouter (dry run). */
  mock?: boolean;
  /** Continue a paused game: the state rebuilt from its recorded answers, with its events. */
  resumeFrom?: { state: EngineState; events: EngineEvent[]; applyOrder: number; spentUsd: number };
  logPrompts?: boolean;
}

export interface RunResult {
  status: 'over' | 'paused';
  state: EngineState;
  spentUsd: number;
  pauseReason?: string;
}

/**
 * `ww play` / `ww resume`: one game with no human seats, printed live. The game loop itself is
 * the server's GameOrchestrator (ARCHITECTURE.md §9.3); this only wires it to the terminal.
 */
export async function runGame(o: RunOptions): Promise<RunResult> {
  const provider: LLMProvider = o.mock
    ? new MockProvider({ seed: 7, costPerCall: 0.0004 })
    : new OpenRouterClient({
        baseUrl: o.env.cfg.app.openrouter.baseUrl,
        apiKey: requireKey(o.env.apiKey),
        referer: o.env.cfg.app.openrouter.referer,
        title: o.env.cfg.app.openrouter.title,
        fetch: globalThis.fetch as never,
      });

  const profilesByAlias = new Map<string, ModelProfile>(o.env.cfg.profilesByAlias);
  const game = new GameOrchestrator({
    store: o.store,
    gameId: o.gameId,
    snapshot: o.snapshot,
    pack: o.pack,
    app: o.env.cfg.app,
    provider,
    entries: o.entries,
    profilesByAlias,
    logPrompts: o.logPrompts ?? false,
    ...(o.resumeFrom ? { resume: o.resumeFrom } : {}),
  });

  // The server's loop stays alive through a pause; the command line does not, so it stops here
  // and the game is continued later with `ww resume`.
  let stopped: (() => void) | null = null;
  const pausedOrOver = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  let names: string[] = seatNames(o.resumeFrom?.events ?? []);
  const nameOf = (n: number) => names[n - 1] ?? `seat ${n}`;
  let warned = false;
  game.subscribe((e) => {
    if (e.type === 'events') {
      if (names.length === 0) names = seatNames(e.events);
      printEvents(e.events, nameOf, o.print);
    } else if (e.type === 'paused') {
      const why = e.reason === 'cost_cap' ? `cost cap reached: $${game.spentUsd.toFixed(3)} spent of $${game.capUsd.toFixed(2)}` : e.reason;
      console.log(bold(`\n[paused] ${why}`));
      stopped?.();
    } else if (e.type === 'over') {
      stopped?.();
    }
    if (!warned && game.capUsd > 0 && game.spentUsd >= 0.8 * game.capUsd) {
      warned = true;
      console.log(bold(`[cost] $${game.spentUsd.toFixed(3)} of the $${game.capUsd.toFixed(2)} cap is spent.`));
    }
  });

  await Promise.race([game.run(), pausedOrOver]);

  if (game.status === 'paused') {
    const reason = game.pauseReason ?? 'host';
    const spent = game.spentUsd;
    game.stop(); // leave the loop; the database already records the pause
    return { status: 'paused', state: game.engineState, spentUsd: spent, pauseReason: reason };
  }
  if (game.notice) console.log(yellow(`[models] ${game.notice}`));
  console.log(green(`Total model cost: $${game.spentUsd.toFixed(4)} (cap $${game.capUsd.toFixed(2)}).`));
  return { status: 'over', state: game.engineState, spentUsd: game.spentUsd };
}

function requireKey(key: string | null): string {
  if (!key) throw new Error('OPENROUTER_API_KEY is not set (put it in .env). Use --mock for a dry run without the API.');
  return key;
}

function seatNames(events: readonly EngineEvent[]): string[] {
  const e = events.find((x) => x.type === 'GAME_START');
  return e ? (e.payload as { seats: { name: string }[] }).seats.map((s) => s.name) : [];
}
