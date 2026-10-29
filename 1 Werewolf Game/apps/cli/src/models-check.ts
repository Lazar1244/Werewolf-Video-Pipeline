import { buildBody, callModel, CostGuard, DecisionClock, defaultSleep, downgradeMode, Limiter, maxTokensFor, OpenRouterClient, resolveMode } from '@ww/llm';
import { finishLlmCall, startLlmCall, type Store } from '@ww/store';
import { bold, dim, green, red, yellow } from './print';
import { resolveCatalog, type Env } from '@ww/server';

/**
 * `ww models check [--ping]` (ARCHITECTURE.md §12): validate every profile against the
 * catalogue, and optionally send one tiny call per profile to prove the key and routing work.
 */
export async function modelsCheck(env: Env, store: Store, opts: { ping: boolean; offline: boolean }): Promise<number> {
  const profiles = env.cfg.profiles;
  const { entries, warnings } = await resolveCatalog(env, store, profiles, { offline: opts.offline });
  for (const w of warnings) console.log(yellow(`[catalogue] ${w}`));
  console.log(bold(`\n${profiles.length} model profiles:`));
  let problems = 0;

  for (const p of profiles) {
    const e = entries.get(p.openrouterId);
    const tags: string[] = [];
    if (!p.enabled) tags.push('disabled');
    if (!e) {
      console.log(red(`  ✗ ${p.alias.padEnd(16)} ${p.openrouterId} — not found`));
      problems++;
      continue;
    }
    const mode = resolveMode(p, e);
    const maxTok = maxTokensFor(p, p.maxOutputTokens, env.cfg.app.effortShare);
    const inPrice = (e.pricing.prompt * 1e6).toFixed(2);
    const outPrice = (e.pricing.completion * 1e6).toFixed(2);
    tags.push(`ctx ${Math.round(e.contextLength / 1000)}k`, `$${inPrice}/$${outPrice} per Mtok`, `output ${mode}`, `max_tokens ${maxTok}`);
    if (e.contextLength < env.cfg.app.minContextTokens) {
      tags.push(red(`context below minContextTokens (${env.cfg.app.minContextTokens})`));
      problems++;
    }
    if (e.source === 'override') tags.push(yellow('offline data'));
    for (const param of ['temperature', 'top_p'] as const) {
      if (p.params[param] !== null && e.source === 'catalog' && e.supportedParameters.length && !e.supportedParameters.includes(param)) {
        tags.push(yellow(`${param} is not supported and will be dropped`));
      }
    }
    if (p.reasoning.enabled && e.source === 'catalog' && e.supportedParameters.length && !e.supportedParameters.includes('reasoning')) {
      tags.push(yellow('reasoning is not supported by this model'));
    }
    console.log(`  ${p.enabled ? green('✓') : dim('·')} ${p.alias.padEnd(16)} ${dim(p.openrouterId)} — ${tags.join(', ')}`);
  }

  if (opts.ping) {
    if (!env.apiKey) {
      console.log(red('\n--ping needs OPENROUTER_API_KEY in .env'));
      return 1;
    }
    console.log(bold('\nPinging each enabled profile with one tiny call…'));
    const provider = new OpenRouterClient({
      baseUrl: env.cfg.app.openrouter.baseUrl,
      apiKey: env.apiKey,
      referer: env.cfg.app.openrouter.referer,
      title: env.cfg.app.openrouter.title,
      fetch: globalThis.fetch as never,
    });
    const limiter = new Limiter(env.cfg.app.globalConcurrency);
    const guard = new CostGuard(1);
    for (const p of profiles.filter((x) => x.enabled)) {
      const e = entries.get(p.openrouterId)!;
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      const t0 = Date.now();
      // Ping like a real game does: allow the same downgrades and one transport retry, but with a
      // tiny output budget so a mandatory-reasoning model cannot run up a bill.
      const tiny = { ...p, maxOutputTokens: 64, reasoning: { ...p.reasoning, maxTokens: Math.min(p.reasoning.maxTokens, 256) } };
      let mode = resolveMode(p, e);
      try {
        const out = await callModel({
          provider,
          limiter,
          alias: p.alias,
          maxConcurrency: 1,
          guard,
          pricing: e.pricing,
          promptTokensEst: 50,
          body: () =>
            buildBody({
              profile: tiny,
              messages: [{ role: 'user', content: 'Reply with {"ok": true} and nothing else.' }],
              schema,
              mode,
              pinnedOutput: 64,
              effortShare: env.cfg.app.effortShare,
              priceCap: e.priceCap,
            }),
          onUnsupported: (err) => {
            if (err.opts.param !== 'response_format') return false;
            const next = downgradeMode(mode);
            if (!next) return false;
            mode = next;
            console.log(dim(`    (${p.alias}: ${err.opts.param} not supported, retrying as ${next})`));
            return true;
          },
          attemptTimeoutMs: 30_000,
          transportRetries: 1,
          clock: new DecisionClock(60_000, Date.now),
          ceilingFraction: 1,
          purpose: 'ping',
          firstAttempt: 1,
          signal: new AbortController().signal,
          // ping calls are logged like any other call, so their cost and latency are on record
          log: {
            sent: (r) =>
              startLlmCall(store, {
                gameId: null,
                requestId: null,
                seat: null,
                profileAlias: p.alias,
                openrouterId: p.openrouterId,
                attempt: r.attempt,
                purpose: 'ping',
                queueMs: Math.round(r.queueMs),
                reservedUsd: r.reservedUsd,
              }),
            done: (id, r) =>
              finishLlmCall(store, id, {
                status: r.status,
                latencyMs: Math.round(r.latencyMs),
                generationId: r.generationId,
                promptTokens: r.usage?.promptTokens ?? null,
                completionTokens: r.usage?.completionTokens ?? null,
                reasoningTokens: r.usage?.reasoningTokens ?? null,
                cachedTokens: r.usage?.cachedTokens ?? null,
                costUsd: r.costUsd,
                costSource: r.costSource,
              }),
          },
          now: Date.now,
          sleep: defaultSleep,
          random: Math.random,
        });
        const note = mode !== resolveMode(p, e) ? yellow(` (needs structuredOutput "${mode}" — consider setting it in models.json)`) : '';
        console.log(`  ${green('✓')} ${p.alias.padEnd(16)} ${Date.now() - t0} ms — ${out.result.text.trim().slice(0, 60)}${note}`);
      } catch (err) {
        problems++;
        console.log(`  ${red('✗')} ${p.alias.padEnd(16)} ${(err as Error).message}`);
      }
    }
    console.log(dim(`\nPing cost: $${guard.spent.toFixed(4)}`));
  }

  console.log(problems === 0 ? green('\nAll profiles look usable.') : red(`\n${problems} problem(s) found.`));
  return problems === 0 ? 0 : 1;
}
