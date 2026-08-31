import { describe, expect, it } from "vitest";
import type { Task } from "../src/domain/index.js";
import { nextActiveTaskIds } from "../src/master/active-tasks.js";

function task(id: string, status: Task["status"]): Task {
  return {
    id,
    projectId: "proj",
    title: id,
    description: id,
    kind: "implementation",
    dependencyIds: [],
    status,
    statusChangedAt: "t",
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("nextActiveTaskIds", () => {
  it("appends newly created IDs after still-active existing IDs", () => {
    expect(
      nextActiveTaskIds(
        ["keep", "done"],
        [task("keep", "pending"), task("done", "completed"), task("new", "pending")],
        ["new"],
      ),
    ).toEqual(["keep", "new"]);
  });

  it("does not emit duplicate IDs", () => {
    expect(
      nextActiveTaskIds(
        ["keep", "keep"],
        [task("keep", "in_progress"), task("new", "pending")],
        ["keep", "new", "new"],
      ),
    ).toEqual(["keep", "new"]);
  });
});
