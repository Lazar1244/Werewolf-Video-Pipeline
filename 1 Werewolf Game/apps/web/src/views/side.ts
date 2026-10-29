import { h, preserveEdits, replace } from '../dom';
import { modelOption, type ModelChoice } from './lobby';
import type { AppState } from '../app';
import { view } from '../app';

/**
 * Your own card: the one place private information is shown, and only to its owner. The rejoin
 * code lives only on this device (it arrived in the join link's fragment), so it is shown here and
 * nowhere else — the host never sees it (ARCHITECTURE.md §9.1).
 */
export function renderRole(body: HTMLElement, s: AppState, rejoinCode: string | null = null): void {
  const v = view(s);
  const me = v?.me;
  if (!v || !me) {
    replace(body, h('p', { class: 'hint', text: s.isHost && !s.isSeat ? 'You are hosting this game, not playing in it.' : 'You are watching this game.' }));
    return;
  }
  const name = (n: number) => v.table[n - 1]?.name ?? `seat ${n}`;
  const facts: string[] = [];
  if (me.pack.length) facts.push(`Your pack: ${me.pack.map((w) => `${name(w.seat)} (${label(w.role)})`).join(', ')}`);
  if (me.infected) facts.push('You were infected: you are with the wolves now, but keep your role');
  if (me.lover) facts.push(`In love with ${name(me.lover.seat)}${me.lover.role ? ` (${label(me.lover.role)})` : ''} — if one dies, so does the other`);
  if (me.sister) facts.push(`Your sister: ${name(me.sister)}`);
  if (me.charmed) facts.push(`Charmed by the Piper. Also charmed: ${me.charmedKnown.filter((x) => x !== me.seat).map(name).join(', ') || 'nobody else yet'}`);
  else if (me.role === 'piper' && me.charmedKnown.length) facts.push(`You have charmed: ${me.charmedKnown.map(name).join(', ')}`);
  if (me.role === 'witch') facts.push(`Potions — healing: ${me.usedHeal ? 'used' : 'ready'}, poison: ${me.usedPoison ? 'used' : 'ready'}`);
  if (!me.powersActive) facts.push('Your special powers are gone');
  if (!me.alive)
    facts.push(
      s.client.pending && !v.result
        ? 'You are dead, but you still have one last action to take.'
        : s.client.lockOpen
          ? 'You are dead. The game is open to you now: you see every card and every thought.'
          : 'You are dead. You can watch, but not act.',
    );

  replace(
    body,
    h('div', { class: 'role' }, label(me.role)),
    h('div', { class: 'team', text: `${me.name} · seat ${me.seat} · team ${me.team}${me.wolfNature ? ' · wolf nature' : ''}` }),
    facts.length ? h('ul', {}, ...facts.map((f) => h('li', { text: f }))) : null,
    rejoinCode
      ? h(
          'p',
          { class: 'hint rejoin' },
          'Your rejoin code: ',
          h('strong', { text: rejoinCode }),
          '. Keep it private. If you lose this device, give it to the host so they can let you back in.',
        )
      : null,
  );
}

/**
 * The private notes pane: the human equivalent of an AI's notebook. The textarea is built once
 * and kept, so a message arriving from the server never takes the caret away mid-sentence.
 */
export function renderNotes(body: HTMLElement, s: AppState, onChange: (text: string) => void): void {
  if (!s.isSeat) {
    if (!body.querySelector('.hint')) replace(body, h('p', { class: 'hint', text: 'Notes are for players.' }));
    return;
  }
  let ta = body.querySelector('textarea');
  let status = body.querySelector<HTMLElement>('.words');
  if (!ta || !status) {
    ta = h('textarea', { rows: 6, maxlength: NOTES_MAX, placeholder: 'Who claimed what? Who voted oddly?', oninput: (e: Event) => onChange((e.target as HTMLTextAreaElement).value.slice(0, NOTES_MAX)) });
    ta.value = s.notes;
    status = h('div', { class: 'words' });
    replace(body, ta, status);
  }
  // only the server's copy may overwrite the box, and never while the player is using it
  if (document.activeElement !== ta && s.notesSaved && ta.value !== s.notes) ta.value = s.notes;
  status.textContent = s.notesSaved ? 'saved' : 'not saved yet';
}

/**
 * What the host's tools need. The people come from `host_status` (names by lobby slot, which say
 * nothing about seats); the models on each seat only exist once the game is open (§9.1), which is
 * also the only time the server allows a seat's model to be replaced (§9.5).
 */
export interface HostTools {
  /** Every enabled model the host could put on a seat. */
  models: ModelChoice[];
  /** The outcome of the last reissue or remap, shown until the next one. */
  result: { ok: boolean; text: string; url?: string } | null;
}

/** Host controls. While the game is hidden the host sees status only, never seat detail. */
export interface HostHandlers {
  command: (cmd: Record<string, unknown>) => void;
  reissue: (slot: number, rejoinCode: string | null) => void;
  remap: (slot: number, alias: string) => void;
  spectatorLink: () => void;
}

let toolsOpen = false;
/** The server's notes limit (`NOTES_MAX_CHARS` in the protocol): the box stops there. */
const NOTES_MAX = 4_000;
/** The host's choices in the tools, kept across rebuilds (a status update must not reset them). */
const picked = { reissueSlot: null as number | null, remapSlot: null as number | null, remapModel: null as string | null };

export function renderHost(body: HTMLElement, s: AppState, hnd: HostHandlers, tools: HostTools | null = null): void {
  preserveEdits(body, () => buildHost(body, s, hnd, tools));
}

function buildHost(body: HTMLElement, s: AppState, hnd: HostHandlers, tools: HostTools | null): void {
  const st = s.client.host;
  const paused = s.client.paused;
  const ended = s.client.status === 'over' || s.client.status === 'aborted';
  // the game itself is decided: only the debrief (and ending it) is left to control
  const afterGame = s.client.status === 'over_offer' || s.client.status === 'debrief' || !!(s.client.scopes.host.view ?? s.client.scopes.spectator.view)?.result;
  const nodes: (HTMLElement | null)[] = [];
  if (st) {
    // who is offline, by the name the host gave them (a lobby slot is not a table seat)
    const offline = (st.humans ?? []).filter((x) => !x.connected).map((x) => x.name);
    nodes.push(
      h(
        'div',
        { class: 'row small' },
        h('span', { class: 'chip', text: `status: ${statusLabel(st.status)}` }),
        h('span', { class: 'chip', text: `cost: $${(st.costUsd ?? 0).toFixed(2)} of $${st.costCapUsd.toFixed(2)}${st.lockOpen ? '' : ' (as of the last dawn or dusk)'}` }),
        st.lockOpen ? null : h('span', { class: 'chip warn', text: 'hidden until no human can act' }),
        !ended && offline.length ? h('span', { class: 'chip danger', text: `offline: ${offline.join(', ')}` }) : null,
      ),
    );
    if (st.notice) nodes.push(h('div', { class: 'banner', text: st.notice }));
  }
  const said = s.client.commandResult;
  if (said) nodes.push(h('div', { class: `banner ${said.ok ? '' : 'danger'}`.trim(), text: said.message }));
  // the offer is only on screen while it is really open (not once the debrief has started)
  if (st?.debriefPending && st.status !== 'debrief') {
    nodes.push(
      h(
        'div',
        { class: 'banner' },
        h('div', { text: 'The game is over. Open the debrief? Everyone — dead players too — writes one comment about the game. It is just for fun.' }),
        h(
          'div',
          { class: 'options mt' },
          h('button', { class: 'primary', onclick: () => hnd.command({ cmd: 'debrief', open: true }) }, 'Open the debrief'),
          h('button', { onclick: () => hnd.command({ cmd: 'debrief', open: false }) }, 'No thanks'),
        ),
      ),
    );
  }
  // a game that cannot go on here: the only thing left to do is abort it
  const terminal = paused?.reason === 'corrupt' || paused?.reason === 'version_mismatch' || paused?.reason === 'not_loaded';
  if (!ended && afterGame) {
    nodes.push(h('div', { class: 'options mt' }, h('button', { class: 'ghost', onclick: () => confirmAbort(hnd) }, s.client.status === 'debrief' ? 'End the debrief now' : 'End the game now')));
  } else if (!ended) {
    nodes.push(
      h(
        'div',
        { class: 'options mt' },
        terminal
          ? null
          : paused
            ? h('button', { class: 'primary', onclick: () => hnd.command({ cmd: 'resume' }) }, 'Resume')
            : h('button', { onclick: () => hnd.command({ cmd: 'pause' }) }, 'Pause'),
        terminal ? null : h('button', { onclick: () => raiseCap(hnd, st?.costCapUsd ?? 1) }, 'Raise the cost cap'),
        terminal ? null : h('button', { onclick: () => hnd.command({ cmd: 'fallback_now', target: 'disconnected' }) }, 'Skip offline players'),
        // a player who has wedged the day: settle just their turn, or every ballot still open
        terminal ? null : h('button', { onclick: () => hnd.command({ cmd: 'fallback_now', target: 'current_speaker' }) }, 'Settle the current turn'),
        terminal ? null : h('button', { onclick: () => hnd.command({ cmd: 'fallback_now', target: 'all_ballots' }) }, 'Settle every open vote'),
        h('button', { class: 'ghost', onclick: () => confirmAbort(hnd) }, 'Abort'),
      ),
    );
  }
  if (paused?.reason === 'cost_cap') nodes.push(h('div', { class: 'banner', text: 'The cost cap was reached. Raise it to carry on — nothing is lost.' }));
  if (paused?.reason === 'humans_disconnected') nodes.push(h('div', { class: 'banner', text: 'Everyone who plays by hand is offline. The game carries on by itself as soon as one of them is back.' }));
  if (paused?.reason === 'recovered') nodes.push(h('div', { class: 'banner', text: 'The server was restarted. The game is exactly where it stopped: press Resume to carry on.' }));
  if (paused?.reason === 'provider_failure')
    nodes.push(
      h('div', {
        class: 'banner',
        text:
          st?.pauseDetail === 'api_key'
            ? 'OpenRouter refused the API key. Fix OPENROUTER_API_KEY in .env, restart the server, then press Resume.'
            : 'A model kept failing (see above for which). Replace it under "More host tools", then press Resume.',
      }),
    );
  if (terminal) nodes.push(h('div', { class: 'banner danger', text: 'This game cannot continue here; you can only abort it.' }));
  if (s.client.status === 'aborted') nodes.push(h('div', { class: 'banner danger', text: 'This game was abandoned.' }));
  if (tools && !ended && !terminal && !afterGame) nodes.push(hostTools(s, hnd, tools));
  replace(body, ...nodes.filter(Boolean));
}

/** A dropdown that remembers the host's choice across rebuilds. */
function remembered(options: { value: string; label: string }[], current: string | null, onPick: (v: string) => void): HTMLSelectElement {
  const value = options.some((o) => o.value === current) ? current : (options[0]?.value ?? null);
  if (value !== null && value !== current) onPick(value);
  return h(
    'select',
    { onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) },
    ...options.map((o) => h('option', { value: o.value, ...(o.value === value ? { selected: 'selected' } : {}) }, o.label)),
  );
}

/** Reissuing a lost player's link and replacing a failing model (ARCHITECTURE.md §9.1, §9.5). */
function hostTools(s: AppState, hnd: HostHandlers, t: HostTools): HTMLElement {
  const lockOpen = s.client.lockOpen;
  const details = h('details', { class: 'tools mt', ...(toolsOpen ? { open: 'open' } : {}), ontoggle: (e: Event) => (toolsOpen = (e.target as HTMLDetailsElement).open) });
  details.appendChild(h('summary', { text: 'More host tools' }));
  const humans = s.client.host?.humans ?? [];

  if (humans.length) {
    const who = remembered(
      humans.map((x) => ({ value: String(x.slot), label: `${x.name}${x.connected ? '' : ' (offline)'}` })),
      picked.reissueSlot === null ? null : String(picked.reissueSlot),
      (v) => (picked.reissueSlot = Number(v)),
    );
    const code = h('input', { type: 'text', placeholder: 'their rejoin code', 'data-k': 'reissue-code', value: '', maxlength: 6, size: 10 });
    details.appendChild(
      h(
        'div',
        { class: 'mt' },
        h('div', { class: 'small', text: 'A player lost their device or their link' }),
        h(
          'div',
          { class: 'row' },
          who,
          lockOpen ? null : code,
          h('button', { onclick: () => hnd.reissue(Number(who.value), lockOpen ? null : code.value.trim() || null) }, 'New link'),
        ),
        h('p', { class: 'hint', text: lockOpen ? 'The game is open now, so no code is needed.' : 'Ask the player for the rejoin code shown on their own card. It only works while their old device is offline.' }),
      ),
    );
  }

  // A seat's model can only be replaced once the game is open: before that the server refuses,
  // and listing models against seats would show the host what no screen may show yet (§9.1, §9.5).
  const names = (n: number) => s.client.scopes.spectator.view?.table[n - 1]?.name ?? s.client.scopes.host.view?.table[n - 1]?.name ?? `seat ${n}`;
  if (lockOpen && s.client.models.length) {
    const slot = remembered(
      s.client.models.map((m) => ({ value: String(m.slot), label: `${names(m.seat)} — ${m.label}` })),
      picked.remapSlot === null ? null : String(picked.remapSlot),
      (v) => (picked.remapSlot = Number(v)),
    );
    const model = remembered(
      t.models.filter((m) => m.enabled).map((m) => ({ value: m.alias, label: modelOption(m) })),
      picked.remapModel,
      (v) => (picked.remapModel = v),
    );
    details.appendChild(
      h(
        'div',
        { class: 'mt' },
        h('div', { class: 'small', text: 'Replace the model playing a seat' }),
        h('div', { class: 'row' }, slot, model, h('button', { onclick: () => hnd.remap(Number(slot.value), model.value) }, 'Replace')),
      ),
    );
  }

  details.appendChild(
    h('div', { class: 'mt' }, h('div', { class: 'small', text: 'Someone wants to watch' }), h('div', { class: 'row' }, h('button', { onclick: () => hnd.spectatorLink() }, 'Spectator link'))),
  );

  if (t.result) {
    details.appendChild(h('div', { class: `banner ${t.result.ok ? '' : 'danger'} mt`.trim() }, h('div', { text: t.result.text }), t.result.url ? h('code', { text: t.result.url }) : null));
  }
  return details;
}

const statusLabel = (status: string): string =>
  ({ running: 'running', paused: 'paused', over_offer: 'over — waiting for your debrief answer', debrief: 'debrief', over: 'over', aborted: 'aborted', lobby: 'lobby' })[status] ?? status;

function raiseCap(hnd: HostHandlers, current: number): void {
  const answer = window.prompt('New cost cap in dollars', String(Math.max(1, Math.ceil(current * 2))));
  const capUsd = Number(answer);
  if (Number.isFinite(capUsd) && capUsd > 0) hnd.command({ cmd: 'raise_cap', capUsd });
}

function confirmAbort(hnd: HostHandlers): void {
  if (window.confirm('Abort this game? A finished game keeps its result; an unfinished one is discarded.')) hnd.command({ cmd: 'abort' });
}

export const label = (id: string): string => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
