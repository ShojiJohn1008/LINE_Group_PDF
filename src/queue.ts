// Serializes async tasks per key (= per tenant/group). references.md appends
// and usage counters are read-modify-write, so two events in the same group
// must never interleave — the second would overwrite the first's append.
// Different keys still run concurrently.
export type KeyedQueue = {
  // Runs `task` after all previously enqueued tasks for `key` settle. The
  // returned promise reflects this task's outcome; a failed task does not
  // block subsequent tasks on the same key.
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
};

export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    run(key, task) {
      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev.then(() => task());
      const tail = result.then(
        () => undefined,
        () => undefined
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      });
      return result;
    }
  };
}
