export type EventName<TEvents extends object> = Extract<keyof TEvents, string>;
export type EventHandler<TPayload> = (
  payload: TPayload,
) => void | Promise<void>;

export interface EventSubscriptionOptions {
  readonly signal?: AbortSignal;
}

type UnknownEventHandler = EventHandler<unknown>;

export class TypedEventBus<TEvents extends object> {
  readonly #listeners = new Map<EventName<TEvents>, Set<UnknownEventHandler>>();

  public on<TKey extends EventName<TEvents>>(
    event: TKey,
    handler: EventHandler<TEvents[TKey]>,
    options: EventSubscriptionOptions = {},
  ): () => void {
    if (options.signal?.aborted === true) return () => undefined;

    let listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }

    const untypedHandler = handler as UnknownEventHandler;
    listeners.add(untypedHandler);
    let active = true;

    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      listeners?.delete(untypedHandler);
      if (listeners?.size === 0) this.#listeners.delete(event);
      options.signal?.removeEventListener("abort", unsubscribe);
    };
    options.signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  }

  public once<TKey extends EventName<TEvents>>(
    event: TKey,
    handler: EventHandler<TEvents[TKey]>,
    options: EventSubscriptionOptions = {},
  ): () => void {
    let unsubscribe = (): void => undefined;
    unsubscribe = this.on(
      event,
      async (payload) => {
        unsubscribe();
        await handler(payload);
      },
      options,
    );
    return unsubscribe;
  }

  /** Invoke all listeners concurrently. Every listener runs even when another fails. */
  public async emit<TKey extends EventName<TEvents>>(
    event: TKey,
    payload: TEvents[TKey],
  ): Promise<void> {
    const handlers = [...(this.#listeners.get(event) ?? [])];
    const results = await Promise.allSettled(
      handlers.map(async (handler) => handler(payload)),
    );
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason as unknown);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} listener(s) failed for event "${event}"`,
      );
    }
  }

  /** Invoke listeners in registration order and stop on the first error. */
  public async emitSerial<TKey extends EventName<TEvents>>(
    event: TKey,
    payload: TEvents[TKey],
  ): Promise<void> {
    const handlers = [...(this.#listeners.get(event) ?? [])];
    for (const handler of handlers) await handler(payload);
  }

  public listenerCount<TKey extends EventName<TEvents>>(event: TKey): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  public clear<TKey extends EventName<TEvents>>(event?: TKey): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }
}
