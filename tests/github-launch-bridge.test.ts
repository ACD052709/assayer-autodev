import { describe, expect, it } from "vitest";
import { createGitHubLaunchBridge } from "../src/dispatch/github-launch-bridge.js";

describe("GitHub launch bridge", () => {
  it("dispatches workflow_dispatch with worker run inputs", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    };
    const bridge = createGitHubLaunchBridge(
      {
        token: "ghs_test",
        repository: "ACD052709/assayer-autodev",
        workflowFile: "autodev-worker.yml",
        ref: "main",
        executionMode: "synthetic-noop",
      },
      fetchFn,
    );

    const result = await bridge.launch("wrun-2cd0a1db-2b32-46a3-acce-a890e1fc57f3");

    expect(result).toEqual({
      workerRunId: "wrun-2cd0a1db-2b32-46a3-acce-a890e1fc57f3",
      launched: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/ACD052709/assayer-autodev/actions/workflows/autodev-worker.yml/dispatches",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      ref: "main",
      inputs: {
        workerRunId: "wrun-2cd0a1db-2b32-46a3-acce-a890e1fc57f3",
        executionMode: "synthetic-noop",
      },
    });
  });

  it("returns launch failure without throwing when GitHub rejects the request", async () => {
    const bridge = createGitHubLaunchBridge(
      {
        token: "ghs_test",
        repository: "ACD052709/assayer-autodev",
        workflowFile: "autodev-worker.yml",
        ref: "main",
        executionMode: "synthetic-noop",
      },
      async () => new Response("nope", { status: 422, statusText: "Unprocessable Entity" }),
    );

    const result = await bridge.launch("wrun-1");

    expect(result.launched).toBe(false);
    expect(result.errorMessage).toContain("422");
  });
});
