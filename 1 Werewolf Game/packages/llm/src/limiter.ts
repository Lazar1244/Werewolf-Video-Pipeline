/**
 * Concurrency slots: one global pool (`app.globalConcurrency`) and one pool per model profile
 * (`maxConcurrency`). A slot is held for exactly one HTTP attempt; queue time is measured
 * separately and never counts against the model's timeout (ARCHITECTURE.md §7.3).
 */
class Semaphore {
  private waiters: (() => void)[] = [];
  private used = 0;
  constructor(private readonly size: number) {}
  async acquire(): Promise<void> {
    if (this.used < this.size) {
      this.used++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.used--;
  }
}

export type Release = () => void;

export class Limiter {
  private readonly global: Semaphore;
  private readonly perProfile = new Map<string, Semaphore>();
  constructor(globalConcurrency: number) {
    this.global = new Semaphore(globalConcurrency);
  }
  /** Take a profile slot, then a global slot (so a busy profile never holds global slots while it waits). */
  async acquire(alias: string, maxConcurrency: number): Promise<Release> {
    let sem = this.perProfile.get(alias);
    if (!sem) {
      sem = new Semaphore(maxConcurrency);
      this.perProfile.set(alias, sem);
    }
    await sem.acquire();
    await this.global.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.global.release();
      sem.release();
    };
  }
}
