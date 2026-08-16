export class ActorQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(
    actorId: string,
    task: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.tails.get(actorId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.tails.set(actorId, chained);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(actorId) === chained) {
        this.tails.delete(actorId);
      }
    }
  }

  get activeActors(): number {
    return this.tails.size;
  }
}
