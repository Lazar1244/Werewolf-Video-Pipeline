import { z } from 'zod';

/** `config/app.json` — server & runtime settings (ARCHITECTURE.md §8). */
export const AppConfigSchema = z.strictObject({
  port: z.int().min(1).max(65535),
  bindAddress: z.string().min(1),
  /**
   * The address other devices use to reach this PC, e.g. "192.168.1.31:3000". Optional: without
   * it, links use the LAN address the server finds (a private address on a real network adapter).
   */
  publicHost: z.string().min(1).nullable().optional(),
  hostFromLocalhost: z.boolean(),
  dbPath: z.string().min(1),
  logsDir: z.string().min(1),
  defaultCostCapUsd: z.number().positive(),
  globalConcurrency: z.int().min(1).max(64),
  transportRetries: z.int().min(0).max(5),
  minContextTokens: z.int().min(4_000),
  logPrompts: z.boolean(),
  revealDelayMs: z.int().min(0),
  providerFailureThreshold: z.int().min(1).max(20),
  pauseOnAllHumansDisconnected: z.boolean(),
  disconnectGraceMs: z.int().min(0),
  disconnectMaxMs: z.int().min(0),
  decisionCeilingMs: z.int().min(5_000),
  defaultFallbackAlias: z.string().min(1).nullable(),
  debriefOfferMs: z.int().min(10_000),
  effortShare: z.strictObject({
    low: z.number().gt(0).lt(1),
    medium: z.number().gt(0).lt(1),
    high: z.number().gt(0).lt(1),
  }),
  openrouter: z.strictObject({
    baseUrl: z.url(),
    referer: z.string().nullable(),
    title: z.string().nullable(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
