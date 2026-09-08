export interface RetryableDeferredModule<T> {
  readonly load: () => Promise<T>;
  readonly peek: () => T | null;
}

export function createRetryableDeferredModule<T>(
  loader: () => Promise<T>,
): RetryableDeferredModule<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;

  return {
    load() {
      if (loaded !== null) {
        return Promise.resolve(loaded);
      }
      if (pending !== null) {
        return pending;
      }

      const attempt = loader()
        .then((value) => {
          loaded = value;
          return value;
        })
        .catch((error: unknown) => {
          if (pending === attempt) {
            pending = null;
          }
          throw error;
        });
      pending = attempt;
      return attempt;
    },
    peek() {
      return loaded;
    },
  };
}
