import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { loadSecrets } from '@ww/config';
import { createServer, LobbyService, type Env } from '@ww/server';
import type { Store } from '@ww/store';
import { bold, dim, green, yellow } from './print';

export interface ServeOptions {
  env: Env;
  store: Store;
  root: string;
  /** Create a lobby right away and print its links. */
  lobby?: { compositionId: string; aliases: string[]; humanSlots: number[]; capUsd: number; discussionRounds?: number | undefined };
  mock?: boolean;
  logPrompts?: boolean;
  port?: number;
}

/**
 * `ww serve` (ARCHITECTURE.md §9): the LAN server. It hosts the lobby, the game orchestrator
 * and the REST/WS gateway; browsers join with the one-time links printed here.
 */
export async function serve(o: ServeOptions): Promise<number> {
  const { app: appCfg } = o.env.cfg;
  const secrets = loadSecrets(o.root);
  if (!secrets.hostToken && !appCfg.hostFromLocalhost) {
    console.log(yellow('HOST_TOKEN is not set and hostFromLocalhost is false: nobody could act as host.'));
    return 1;
  }
  const webDir = join(o.root, 'apps/web/dist');
  const hasUi = existsSync(join(webDir, 'index.html'));
  if (!hasUi) console.log(yellow('The web interface is not built yet: run `npm run build:web` (the API still works).'));
  const server = await createServer({
    env: o.env,
    store: o.store,
    hostToken: secrets.hostToken,
    mock: o.mock ?? false,
    logPrompts: o.logPrompts ?? false,
    ...(hasUi ? { webDir } : {}),
  });
  // games interrupted by a crash come back paused; the host resumes them (§9.4)
  const recovered = await (server as unknown as { ww: { recoverAll: () => Promise<{ gameId: string; problem: string | null }[]> } }).ww.recoverAll();
  for (const r of recovered) {
    console.log(r.problem ? yellow(`[recovery] ${r.gameId}: ${r.problem}`) : dim(`[recovery] ${r.gameId} is paused and waiting for you to resume it`));
  }
  const port = o.port ?? appCfg.port;
  await server.listen({ port, host: appCfg.bindAddress });

  const urls = addressesFor(port);
  console.log(bold(`\nWearwolfe server listening on ${appCfg.bindAddress}:${port}`));
  for (const u of urls) console.log(`  ${u}`);
  console.log(dim(`host access: ${appCfg.hostFromLocalhost ? 'automatic from this machine' : 'send the HOST_TOKEN header'}`));
  if (o.mock) console.log(yellow('MOCK mode: seats answer from the schema, no API calls and no cost.'));

  if (o.lobby) {
    const lobbies = new LobbyService(o.env, o.store);
    const draft = lobbies.defaultDraft(o.lobby.compositionId, o.lobby.aliases);
    for (const slot of o.lobby.humanSlots) {
      const s = draft.slots.find((x) => x.slot === slot);
      if (s) {
        s.controller = 'human';
        s.alias = null;
        s.humanName = `Player ${slot}`;
      }
    }
    draft.costCapUsd = o.lobby.capUsd;
    if (o.lobby.discussionRounds !== undefined) draft.rulesOverride = { ...draft.rulesOverride, discussion_rounds: o.lobby.discussionRounds };
    const id = lobbies.create(draft);
    const links = lobbies.issueLinks(id, urls[0] ?? `http://localhost:${port}`);
    console.log(bold(`\nLobby ${id}`));
    console.log(dim(`${draft.compositionId} · cap $${draft.costCapUsd.toFixed(2)} · ${o.lobby.humanSlots.length} human seat(s)`));
    for (const s of links.seats) console.log(`  ${green(s.humanName)}: ${s.url}`);
    console.log(`  ${dim('spectator')}: ${links.spectator}`);
    console.log(dim('Each player sees a private rejoin code when they open their link; you never see it.'));
    console.log(dim(`\nStart the game with: curl -X POST ${urls[0] ?? ''}/api/lobbies/${id}/start`));
  }
  console.log(dim('\nPress Ctrl+C to stop.'));
  await new Promise(() => undefined); // run until interrupted
  return 0;
}

/** The addresses other devices on the LAN can use. */
function addressesFor(port: number): string[] {
  const out = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${port}`);
    }
  }
  return out;
}
