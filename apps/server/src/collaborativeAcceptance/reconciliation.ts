import * as Effect from "effect/Effect";

export const retryReconciliationCas = <A, E>(
  effect: Effect.Effect<A, E>,
  isConflict: (error: E) => boolean,
) =>
  effect.pipe(
    Effect.retry({
      times: 3,
      while: isConflict,
    }),
  );

export const runReconciliationBatch = <Item, E, R>(
  items: ReadonlyArray<Item>,
  reconcile: (item: Item) => Effect.Effect<void, E, R>,
  onFailure: (item: Item, error: E) => Effect.Effect<void, never, R>,
) =>
  Effect.forEach(
    items,
    (item) => reconcile(item).pipe(Effect.catch((error) => onFailure(item, error))),
    { concurrency: 1, discard: true },
  );

export const runReconciliationTick = <R>(
  tick: Effect.Effect<void, unknown, R>,
  onFailure: (error: unknown) => Effect.Effect<void, never, R>,
) => tick.pipe(Effect.catch(onFailure));
