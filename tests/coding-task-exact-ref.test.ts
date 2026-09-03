import { describe, expect, it } from "vitest";
import {
  prepareIsolatedCheckout,
} from "../src/actuator/coding-task-checkout.js";
import { isolatedCheckoutDirectory } from "../src/actuator/codex-cli.js";
import type { WorkerTaskPacket } from "../src/domain/worker-task-packet.js";

describe("exact target commit checkout", () => {
  it("fetches and checks out a 40-character target SHA instead of treating it as a branch", async () => {
    const sha = "a".repeat(40);

    const packet: WorkerTaskPacket = {
      workerRunId: "wrun-exact-ref",
      taskId: "task-exact-ref",
      projectId: "project-exact-ref",
      task: {
        id: "task-exact-ref",
        title: "Exact commit checkout",
        description: "Regression proof",
        kind: "implementation",
        status: "in_progress",
      },
      requirements: [],
      acceptanceCriteria: [],
      blockers: [],
      doNotModifyConstraints: [],
      targetRepository: "ACD052709/example-target",
      targetRef: sha,
      targetTestCommand: "npm test",
      execution: {
        workerKind: "generic",
        iteration: 1,
        status: "running",
        ownerId: "owner-test",
      },
    };

    const calls: Array<{
      args: string[];
      cwd?: string;
    }> = [];

    await prepareIsolatedCheckout({
      packet,
      workspaceRoot: "/tmp/work",
      git: {
        async run(args, cwd) {
          calls.push({
            args: [...args],
            ...(cwd !== undefined ? { cwd } : {}),
          });
          return 0;
        },
      },
    });

    const checkoutDir = isolatedCheckoutDirectory(
      "/tmp/work",
      "wrun-exact-ref",
    );

    expect(calls).toEqual([
      {
        args: [
          "clone",
          "--no-checkout",
          "https://github.com/ACD052709/example-target.git",
          checkoutDir,
        ],
      },
      {
        args: ["fetch", "--depth", "1", "origin", sha],
        cwd: checkoutDir,
      },
      {
        args: ["checkout", "--detach", sha],
        cwd: checkoutDir,
      },
    ]);

    expect(calls[0]!.args).not.toContain("--branch");
  });
});
