import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";
import { parseBrowserTestSpec } from "../src/verifier/browser-spec.js";
import { runBrowserSuite } from "../src/verifier/browser-runner.js";
import {
  createVerifierControlPlaneClient,
  persistBrowserVerification,
} from "../src/verifier/control-plane-client.js";
import { startBrowserVerifierFixture } from "./fixtures/browser-verifier-server.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";

function createApiHarness() {
  const syncStore = createInMemoryStateStore();
  const store = asAsyncStore(syncStore);
  const blobs = new InMemoryEvidenceBlobStore();
  const router = createApiRouter({
    deps: { store, blobs },
    auth: { serviceToken: TEST_TOKEN, production: false },
  });
  const fetchImpl: typeof fetch = (input, init) =>
    router(new Request(input instanceof Request ? input : String(input), init));
  const client = createVerifierControlPlaneClient({
    controlPlaneUrl: BASE,
    serviceToken: TEST_TOKEN,
    fetchImpl,
  });
  return { syncStore, fetchImpl, client };
}

async function apiPost(fetchImpl: typeof fetch, path: string, body: unknown): Promise<Response> {
  return fetchImpl(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("browser verifier local end-to-end smoke", () => {
  it("proves PASS registration → execution → evidence → test results → verifier completion", async () => {
    const { syncStore, fetchImpl, client } = createApiHarness();
    await apiPost(fetchImpl, "/api/projects", {
      id: "proj-e2e-pass",
      name: "E2E pass",
      description: "Browser verifier PASS smoke",
    });
    await apiPost(fetchImpl, "/api/tasks", {
      id: "task-e2e-pass",
      projectId: "proj-e2e-pass",
      title: "Verify fixture",
      description: "PASS smoke",
      kind: "verification",
    });

    const registered = await client.createTestCase({
      id: "tc-e2e-pass",
      projectId: "proj-e2e-pass",
      taskId: "task-e2e-pass",
      name: "Fixture home flow",
      description: "Navigate and assert fixture home",
      kind: "browser",
    });
    expect(registered.kind).toBe("browser");

    const fixture = await startBrowserVerifierFixture();
    try {
      const { createPlaywrightAutomation } = await import("../src/verifier/playwright-automation.js");
      const automation = await createPlaywrightAutomation();
      const spec = parseBrowserTestSpec({
        version: 1,
        baseUrl: fixture.baseUrl,
        defaultStepTimeoutMs: 5_000,
        defaultCaseTimeoutMs: 15_000,
        cases: [
          {
            id: "case-e2e-pass",
            name: "Fixture home flow",
            steps: [
              { action: "navigate", url: "/" },
              { action: "assertPageLoad" },
              { action: "assertVisibleText", text: "Fixture home" },
              { action: "click", selector: "#go-form" },
            ],
          },
        ],
      });

      const result = await runBrowserSuite({
        spec,
        automation,
        screenshotDir: "test-artifacts/browser-e2e-pass",
      });
      expect(result.outcome).toBe("PASS");

      const persisted = await persistBrowserVerification({
        client,
        projectId: "proj-e2e-pass",
        taskId: "task-e2e-pass",
        verifierRunId: "ver-e2e-pass",
        testCaseIdsBySpecId: { "case-e2e-pass": "tc-e2e-pass" },
        result,
        nextEvidenceId: (caseId, kind) => `ev-${caseId}-${kind}`,
        nextTestResultId: (caseId) => `tr-${caseId}`,
      });

      expect(persisted.verifierRun.status).toBe("completed");
      expect(persisted.verifierRun.outcome).toBe("PASS");
      expect(persisted.testResults).toHaveLength(1);
      expect(persisted.testResults[0]!.outcome).toBe("PASS");
      expect(persisted.evidenceIds.length).toBeGreaterThanOrEqual(1);

      const evidence = syncStore.listEvidenceByTask("task-e2e-pass");
      expect(evidence.some((item) => item.kind === "report")).toBe(true);
      expect(syncStore.listTestResultsByProject("proj-e2e-pass")).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("proves FAIL assertion → screenshot evidence → FAIL test result → verifier completion", async () => {
    const { syncStore, fetchImpl, client } = createApiHarness();
    await apiPost(fetchImpl, "/api/projects", {
      id: "proj-e2e-fail",
      name: "E2E fail",
      description: "Browser verifier FAIL smoke",
    });
    await apiPost(fetchImpl, "/api/tasks", {
      id: "task-e2e-fail",
      projectId: "proj-e2e-fail",
      title: "Verify fixture fail",
      description: "FAIL smoke",
      kind: "verification",
    });

    await client.createTestCase({
      id: "tc-e2e-fail",
      projectId: "proj-e2e-fail",
      taskId: "task-e2e-fail",
      name: "Missing text assertion",
      description: "Deterministic failure",
      kind: "browser",
    });

    const fixture = await startBrowserVerifierFixture();
    try {
      const { createPlaywrightAutomation } = await import("../src/verifier/playwright-automation.js");
      const automation = await createPlaywrightAutomation();
      const spec = parseBrowserTestSpec({
        version: 1,
        baseUrl: fixture.baseUrl,
        cases: [
          {
            id: "case-e2e-fail",
            name: "Missing text assertion",
            steps: [
              { action: "navigate", url: "/" },
              { action: "assertVisibleText", text: "Text that does not exist on fixture" },
            ],
          },
        ],
      });

      const result = await runBrowserSuite({
        spec,
        automation,
        screenshotDir: "test-artifacts/browser-e2e-fail",
      });
      expect(result.outcome).toBe("FAIL");
      expect(result.caseResults[0]!.screenshotPath).toBeDefined();

      const persisted = await persistBrowserVerification({
        client,
        projectId: "proj-e2e-fail",
        taskId: "task-e2e-fail",
        verifierRunId: "ver-e2e-fail",
        testCaseIdsBySpecId: { "case-e2e-fail": "tc-e2e-fail" },
        result,
        nextEvidenceId: (caseId, kind) => `ev-${caseId}-${kind}`,
        nextTestResultId: (caseId) => `tr-${caseId}`,
      });

      expect(persisted.verifierRun.outcome).toBe("FAIL");
      expect(persisted.testResults[0]!.outcome).toBe("FAIL");
      expect(persisted.testResults[0]!.message).toBeTruthy();

      const evidence = syncStore.listEvidenceByTask("task-e2e-fail");
      expect(evidence.some((item) => item.kind === "report")).toBe(true);
      expect(evidence.some((item) => item.kind === "screenshot")).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
