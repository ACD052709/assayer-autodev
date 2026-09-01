import { describe, expect, it } from "vitest";
import { createGitHubVerifierLaunchBridge } from "../src/orchestrator/verifier-launch-bridge.js";

describe("GitHub verifier launch bridge", () => {
  it("dispatches browser verifier workflow without Cursor credentials", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    };
    const bridge = createGitHubVerifierLaunchBridge(
      {
        token: "ghs_test",
        repository: "ACD052709/assayer-autodev",
        workflowFile: "autodev-browser-verifier.yml",
        ref: "main",
      },
      fetchFn,
    );

    const result = await bridge.launch({
      verifierRunId: "ver-task-1-wrun-1",
      projectId: "proj-1",
      taskId: "task-1",
      testCaseId: "tc-verify-task-1",
      workerRunId: "wrun-1",
      codeCandidateId: "cand-task-1-wrun-1",
    });

    expect(result).toEqual({ verifierRunId: "ver-task-1-wrun-1", launched: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("autodev-browser-verifier.yml/dispatches");
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      inputs: Record<string, string>;
    };
    expect(body.inputs).toEqual({
      verifierRunId: "ver-task-1-wrun-1",
      projectId: "proj-1",
      taskId: "task-1",
      testCaseId: "tc-verify-task-1",
      workerRunId: "wrun-1",
      codeCandidateId: "cand-task-1-wrun-1",
    });
    expect(JSON.stringify(body)).not.toContain("CURSOR");
    expect(JSON.stringify(body)).not.toContain("executionMode");
  });
});
