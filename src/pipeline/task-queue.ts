/**
 * Runs work after the webhook has already answered Sendblue, and tracks it so
 * tests can wait for it and shutdown can let in-flight replies finish.
 */
export class TaskQueue {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly onError: (err: unknown) => void) {}

  run(task: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch((err) => this.onError(err))
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  get size(): number {
    return this.inFlight.size;
  }

  /** Resolves once every queued task, including ones queued meanwhile, is done. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
