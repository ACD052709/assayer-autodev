import type { EntityId } from "../domain/index.js";
import { isTerminalTaskStatus, type Task } from "../domain/index.js";

/**
 * Deterministic next active-task list after Master persists proposals.
 * Existing still-active IDs keep their order; newly created IDs append in persist order.
 * Terminal tasks are dropped. Duplicates are not emitted.
 */
export function nextActiveTaskIds(
  existingActiveIds: readonly EntityId[],
  tasks: readonly Task[],
  newlyCreatedIds: readonly EntityId[],
): readonly EntityId[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<EntityId>();
  const next: EntityId[] = [];

  const consider = (id: EntityId): void => {
    if (seen.has(id)) {
      return;
    }
    const task = byId.get(id);
    if (task === undefined || isTerminalTaskStatus(task.status)) {
      return;
    }
    seen.add(id);
    next.push(id);
  };

  for (const id of existingActiveIds) {
    consider(id);
  }
  for (const id of newlyCreatedIds) {
    consider(id);
  }
  return next;
}
