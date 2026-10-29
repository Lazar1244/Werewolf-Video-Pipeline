import { randomBot } from '@ww/engine';
import type { Answer, DecisionRequest } from '@ww/shared';
import type { Game } from '@ww/engine';

/**
 * Bot controller: the engine's random-but-legal bot, for force-started slots and dry runs.
 * Games with a bot seat are excluded from model statistics (ARCHITECTURE.md §9.2).
 */
export class BotController {
  private readonly bot: ReturnType<typeof randomBot>;
  constructor(seed: string) {
    this.bot = randomBot(seed);
  }
  decide(req: DecisionRequest): Answer {
    return this.bot(req, undefined as unknown as Readonly<Game>);
  }
}
