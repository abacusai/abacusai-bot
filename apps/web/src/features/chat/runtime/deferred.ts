/** A promise with its settle functions outside (readiness, dispatcher wake-ups). */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

export const deferred = <T>(): Deferred<T> => {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    },
  };
};
