import { describe, expect, it } from "vitest";
import { createSubprocessRunner } from "../src/actuator/process-runner.js";

describe("createSubprocessRunner", () => {
  it("does not launch a subprocess when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await createSubprocessRunner().run({
      command: "autodev-command-that-does-not-exist",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Process launch skipped because execution was already aborted",
      timedOut: false,
    });
  });
});
