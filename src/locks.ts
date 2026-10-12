import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const locks = new Map<
  string,
  { semaphore: Semaphore.Semaphore; users: number }
>();

export const withLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let lock = locks.get(key);
      if (!lock) {
        lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(key, lock);
      }
      lock.users++;
      return lock;
    }),
    (lock) => lock.semaphore.withPermit(effect),
    (lock) =>
      Effect.sync(() => {
        if (--lock.users === 0) locks.delete(key);
      }),
  );
