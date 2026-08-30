import type { StateStore } from "./store.js";

/** Async persistence contract for D1 and HTTP handlers. */
export type AsyncStateStore = {
  [K in keyof StateStore]: StateStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never;
};

function collectMethodNames(store: StateStore): string[] {
  const names = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(store);
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor" && typeof (store as unknown as Record<string, unknown>)[name] === "function") {
        names.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

/** Wraps a sync StateStore for async HTTP handlers and D1 migration tests. */
export function asAsyncStore(store: StateStore): AsyncStateStore {
  const asyncStore = Object.create(null) as Record<string, unknown>;
  for (const name of collectMethodNames(store)) {
    const fn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    asyncStore[name] = (...args: unknown[]) => Promise.resolve(fn.apply(store, args));
  }
  return asyncStore as unknown as AsyncStateStore;
}
