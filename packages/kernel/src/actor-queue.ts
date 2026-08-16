import { KernelError } from "./errors.js";

export type ActorTask<TResult> = () => TResult | Promise<TResult>;

/**
 * Serializes mutations for the same actor key while allowing unrelated actors
 * to proceed concurrently. A rejected task never poisons the following task.
 */
export class ActorQueue<TKey = string> {
  readonly #tails = new Map<TKey, Promise<void>>();
  readonly #pending = new Map<TKey, number>();
  #closed = false;

  public run<TResult>(key: TKey, task: ActorTask<TResult>): Promise<TResult> {
    if (this.#closed) {
      return Promise.reject(
        new KernelError("actor_queue_closed", "Actor queue is closed"),
      );
    }

    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);

    const result = predecessor.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);

    void tail.then(() => {
      const remaining = (this.#pending.get(key) ?? 1) - 1;
      if (remaining === 0) this.#pending.delete(key);
      else this.#pending.set(key, remaining);
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  public enqueue<TResult>(
    key: TKey,
    task: ActorTask<TResult>,
  ): Promise<TResult> {
    return this.run(key, task);
  }

  public pendingFor(key: TKey): number {
    return this.#pending.get(key) ?? 0;
  }

  public get pendingCount(): number {
    let total = 0;
    for (const count of this.#pending.values()) total += count;
    return total;
  }

  public async onIdle(key?: TKey): Promise<void> {
    if (key !== undefined) {
      await (this.#tails.get(key) ?? Promise.resolve());
      return;
    }

    while (this.#tails.size > 0) {
      await Promise.all([...this.#tails.values()]);
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await this.onIdle();
  }

  public get closed(): boolean {
    return this.#closed;
  }
}
