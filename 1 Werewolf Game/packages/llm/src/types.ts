import type { ChatMessage } from '@ww/shared';

/** One chat-completions request as sent to OpenRouter (ARCHITECTURE.md §7.3). */
export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { max_tokens?: number; effort?: 'low' | 'medium' | 'high'; exclude?: boolean };
  response_format?: { type: 'json_object' } | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
  /** `max_price`: OpenRouter's routing ceiling, USD per million tokens (endpoints above it are never used). */
  provider?: { order?: string[]; allow_fallbacks: boolean; require_parameters?: boolean; max_price?: { prompt: number; completion: number } };
  usage: { include: true };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface CompletionResult {
  /** The visible answer text. */
  text: string;
  generationId: string | null;
  usage: Usage | null;
  /** `usage.cost` from the response, when present. */
  cost: number | null;
  finishReason: string | null;
}

export type ProviderErrorKind =
  | 'rate_limit' // 429: retry with backoff
  | 'server' // 5xx / 408: retry
  | 'network' // connection failure: retry
  | 'timeout' // our attempt timeout: retry
  | 'unsupported' // 400 naming a parameter, or 404 "no endpoints" with require_parameters: downgrade
  | 'bad_request' // other 4xx: no retry
  | 'auth' // 401/402/403: no retry, fatal for the game
  | 'aborted'; // the caller aborted

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly opts: { status?: number; param?: string; retryAfterMs?: number; generationId?: string } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }
}

/** Anything that can answer a chat completion (OpenRouter, or a mock in tests). */
export interface LLMProvider {
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
  /** Cost of a finished generation (OpenRouter `GET /generation`), or null when unknown. */
  generationCost?(id: string, signal: AbortSignal): Promise<number | null>;
}
