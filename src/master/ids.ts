import type { EntityId } from "../domain/index.js";

export interface IdFactory {
  next(prefix: string): EntityId;
}

export function createRandomIdFactory(): IdFactory {
  return {
    next(prefix: string): EntityId {
      const uuid = crypto.randomUUID();
      return `${prefix}-${uuid}`;
    },
  };
}

export function createSequentialIdFactory(start = 1): IdFactory {
  let current = start;
  return {
    next(prefix: string): EntityId {
      const value = current;
      current += 1;
      return `${prefix}-${value}`;
    },
  };
}
