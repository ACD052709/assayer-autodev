import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";
import { assertUrlWithinBaseOrigin, parseBrowserTestSpec, resolveUrl } from "../src/verifier/browser-spec.js";
import { runBrowserSuite } from "../src/verifier/browser-runner.js";
import { BrowserVerifierError } from "../src/verifier/errors.js";
import {
  createVerifierControlPlaneClient,
  persistBrowserVerification,
} from "../src/verifier/control-plane-client.js";
import type {
  BrowserAutomation,
  BrowserPageSession,
  BrowserSuiteResult,
} from "../src/verifier/types.js";
import { startBrowserVerifierFixture } from "./fixtures/browser-verifier-server.js";

class MockPageSession implements BrowserPageSession {
  readonly consoleErrors: string[] = [];
  readonly failedNetworkRequests: Array<{ url: string; status?: number; method?: string }> = [];
  finalUrl: string;
  readonly hiddenSelectors = new Set<string>();
  readonly textContent = new Map<string, boolean>();
  readonly values = new Map<string, string>();
  checked = false;
  enabled = true;
  loadDelayMs = 0;

  constructor(baseUrl: string) {
    this.finalUrl = baseUrl;
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    if (url.includes("/missing")) {
      throw new Error("Navigation failed");
    }
    if (url.includes("/slow")) {
      await new Promise((resolve) => setTimeout(resolve, this.loadDelayMs));
      if (this.loadDelayMs > timeoutMs) {
        throw new Error(`Navigation timed out after ${timeoutMs}ms`);
      }
    }
    this.finalUrl = url;
  }

  async assertPageLoad(timeoutMs: number): Promise<void> {
    if (this.loadDelayMs > timeoutMs) {
      throw new Error(`Page load timed out after ${timeoutMs}ms`);
    }
  }

  async find(input: { selector?: string; text?: string; exact?: boolean }, _timeoutMs: number): Promise<void> {
    if (input.selector === "#missing") {
      throw new Error("Element not found");
    }
    if (input.text !== undefined && !this.textContent.has(input.text)) {
      throw new Error(`Text not found: ${input.text}`);
    }
  }

  async click(input: { selector?: string; text?: string; exact?: boolean }, _timeoutMs: number): Promise<void> {
    await this.find(input, _timeoutMs);
    if (input.selector === "#toggle-hidden") {
      this.hiddenSelectors.add("#panel");
    }
  }

  async fill(selector: string, value: string, _timeoutMs: number): Promise<void> {
    this.values.set(selector, value);
  }

  async assertVisibleText(text: string, exact: boolean, _timeoutMs: number): Promise<void> {
    if (!this.textContent.has(text)) {
      throw new Error(`Expected visible text ${exact ? "exactly " : ""}${text}`);
    }
  }

  async assertElementVisible(selector: string, _timeoutMs: number): Promise<void> {
    if (this.hiddenSelectors.has(selector)) {
      throw new Error(`Expected ${selector} to be visible`);
    }
  }

  async assertElementHidden(selector: string, _timeoutMs: number): Promise<void> {
    if (!this.hiddenSelectors.has(selector)) {
      throw new Error(`Expected ${selector} to be hidden`);
    }
  }

  async assertChecked(selector: string, checked: boolean, _timeoutMs: number): Promise<void> {
    if (this.checked !== checked) {
      throw new Error(`Expected ${selector} checked=${String(checked)}`);
    }
  }

  async assertEnabled(selector: string, enabled: boolean, _timeoutMs: number): Promise<void> {
    if (this.enabled !== enabled) {
      throw new Error(`Expected ${selector} enabled=${String(enabled)}`);
    }
  }

  async screenshot(_path: string): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }
}

class MockBrowserAutomation implements BrowserAutomation {
  readonly pages: MockPageSession[] = [];
  loadDelayMs = 0;

  async open(baseUrl: string): Promise<BrowserPageSession> {
    const page = new MockPageSession(baseUrl);
    page.loadDelayMs = this.loadDelayMs;
    page.textContent.set("Done", true);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.pages.length = 0;
  }
}

describe("browser verifier spec", () => {
  it("keeps exact-candidate loopback navigation on the candidate origin", () => {
    expect(resolveUrl("http://127.0.0.1:4173/", "/settings")).toBe(
      "http://127.0.0.1:4173/settings",
    );
    expect(() => resolveUrl("http://127.0.0.1:4173/", "https://example.com/")).toThrow(
      /cannot navigate outside/i,
    );
    expect(() =>
      assertUrlWithinBaseOrigin("http://127.0.0.1:4173/", "https://example.com/after-click"),
    ).toThrow(/cannot navigate outside/i);
  });
  it("rejects unsupported browser actions", () => {
    expect(() =>
      parseBrowserTestSpec({
        version: 1,
        baseUrl: "http://example.test",
        cases: [{ id: "c1", name: "bad", steps: [{ action: "explore" }] }],
      }),
    ).toThrow(BrowserVerifierError);
  });
});

describe("browser verifier runner (mock automation)", () => {
  it("runs navigation, lookup, click/fill, and assertions successfully", async () => {
    const automation = new MockBrowserAutomation();
    const spec = parseBrowserTestSpec({
      version: 1,
      baseUrl: "http://example.test",
      defaultStepTimeoutMs: 200,
      defaultCaseTimeoutMs: 2_000,
      cases: [
        {
          id: "case-happy",
          name: "Happy path",
          steps: [
            { action: "navigate", url: "/home" },
            { action: "assertPageLoad" },
            { action: "find", selector: "#go-form" },
            { action: "click", selector: "#go-form" },
            { action: "fill", selector: "#name", value: "Ada" },
            { action: "assertVisibleText", text: "Done" },
            { action: "assertElementVisible", selector: "#panel" },
            { action: "assertChecked", selector: "#agree", checked: false },
            { action: "assertEnabled", selector: "#submit", enabled: true },
          ],
        },
      ],
    });

    const result = await runBrowserSuite({ spec, automation });
    expect(result.outcome).toBe("PASS");
    expect(result.caseResults[0]!.finalUrl).toContain("/home");
  });

  it("returns structured FAIL evidence for deterministic assertion failure", async () => {
    const automation = new MockBrowserAutomation();
    const spec = parseBrowserTestSpec({
      version: 1,
      baseUrl: "http://example.test",
      cases: [
        {
          id: "case-fail",
          name: "Fails visibly",
          steps: [{ action: "assertVisibleText", text: "Missing text" }],
        },
      ],
    });
    const result = await runBrowserSuite({ spec, automation, screenshotDir: "test-artifacts/browser" });
    expect(result.outcome).toBe("FAIL");
    expect(result.caseResults[0]!.failureMessage).toContain("Missing text");
    expect(result.caseResults[0]!.outcome).toBe("FAIL");
  });

  it("fails with structured timeout result", async () => {
    const automation = new MockBrowserAutomation();
    automation.loadDelayMs = 500;
    const spec = parseBrowserTestSpec({
      version: 1,
      baseUrl: "http://example.test",
      defaultCaseTimeoutMs: 100,
      cases: [
        {
          id: "case-timeout",
          name: "Timeout",
          timeoutMs: 100,
          steps: [{ action: "navigate", url: "/slow", timeoutMs: 100 }],
        },
      ],
    });
    const result = await runBrowserSuite({ spec, automation });
    expect(result.outcome).toBe("FAIL");
    expect(result.caseResults[0]!.failureMessage).toMatch(/timed out/i);
  });
});

describe("browser verifier control-plane persistence", () => {
  it("creates verifier run, test results, evidence, and completes with PASS/FAIL", async () => {
    const syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    const blobs = new InMemoryEvidenceBlobStore();
    const router = createApiRouter({
      deps: { store, blobs },
      auth: { serviceToken: "test-service-token", production: false },
    });
    const fetchImpl: typeof fetch = (input, init) =>
      router(new Request(input instanceof Request ? input : String(input), init));

    syncStore.createProject({ id: "proj-browser", name: "Browser", description: "Verifier" });
    syncStore.createTask({
      id: "task-browser",
      projectId: "proj-browser",
      title: "Verify UI",
      description: "Browser verification",
      kind: "verification",
    });
    syncStore.createTestCase({
      id: "tc-pass",
      projectId: "proj-browser",
      name: "Pass case",
      description: "Pass",
      kind: "browser",
      taskId: "task-browser",
    });
    syncStore.createTestCase({
      id: "tc-fail",
      projectId: "proj-browser",
      name: "Fail case",
      description: "Fail",
      kind: "browser",
      taskId: "task-browser",
    });

    const client = createVerifierControlPlaneClient({
      controlPlaneUrl: "http://localhost",
      serviceToken: "test-service-token",
      fetchImpl,
    });

    const result: BrowserSuiteResult = {
      outcome: "FAIL",
      durationMs: 12,
      summary: "One case failed",
      caseResults: [
        {
          testCaseId: "case-pass",
          testCaseName: "Pass",
          outcome: "PASS",
          durationMs: 5,
          finalUrl: "http://example.test/ok",
          consoleErrors: [],
          failedNetworkRequests: [],
        },
        {
          testCaseId: "case-fail",
          testCaseName: "Fail",
          outcome: "FAIL",
          durationMs: 7,
          finalUrl: "http://example.test/bad",
          consoleErrors: ["boom"],
          failedNetworkRequests: [{ url: "http://example.test/missing.png", status: 404 }],
          failureMessage: "assertion failed",
        },
      ],
    };

    const persisted = await persistBrowserVerification({
      client,
      projectId: "proj-browser",
      taskId: "task-browser",
      verifierRunId: "ver-browser-1",
      testCaseIdsBySpecId: { "case-pass": "tc-pass", "case-fail": "tc-fail" },
      result,
      nextEvidenceId: (caseId, kind) => `ev-${caseId}-${kind}`,
      nextTestResultId: (caseId) => `tr-${caseId}`,
    });

    expect(persisted.verifierRun.outcome).toBe("FAIL");
    expect(persisted.testResults).toHaveLength(2);
    expect(persisted.evidenceIds.length).toBeGreaterThanOrEqual(2);
    expect(syncStore.listTestResultsByProject("proj-browser")).toHaveLength(2);
  });
});

describe("browser verifier playwright integration", () => {
  it("executes deterministic browser steps against the local fixture", async () => {
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
            id: "case-fixture",
            name: "Fixture flow",
            steps: [
              { action: "navigate", url: "/" },
              { action: "assertPageLoad" },
              { action: "find", text: "Fixture home" },
              { action: "click", selector: "#go-form" },
              { action: "navigate", url: "/form" },
              { action: "fill", selector: "#name", value: "Verifier" },
              { action: "assertElementVisible", selector: "#submit" },
            ],
          },
        ],
      });
      const result = await runBrowserSuite({
        spec,
        automation,
        screenshotDir: "test-artifacts/browser-playwright",
      });
      expect(result.outcome).toBe("PASS");
      expect(result.caseResults[0]!.finalUrl).toContain("/form");
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("captures failure screenshot path on assertion failure", async () => {
    const fixture = await startBrowserVerifierFixture();
    try {
      const { createPlaywrightAutomation } = await import("../src/verifier/playwright-automation.js");
      const automation = await createPlaywrightAutomation();
      const spec = parseBrowserTestSpec({
        version: 1,
        baseUrl: fixture.baseUrl,
        cases: [
          {
            id: "case-screenshot",
            name: "Screenshot on fail",
            steps: [{ action: "assertVisibleText", text: "Text that does not exist" }],
          },
        ],
      });
      const result = await runBrowserSuite({
        spec,
        automation,
        screenshotDir: "test-artifacts/browser-playwright",
      });
      expect(result.outcome).toBe("FAIL");
      expect(result.caseResults[0]!.screenshotPath).toBeDefined();
    } finally {
      await fixture.close();
    }
  }, 60_000);
});

describe("existing actuator modes remain unchanged", () => {
  it("still exports synthetic-noop and coding-task execution modes", async () => {
    const actuator = await import("../src/actuator/types.js");
    expect(actuator.EXECUTION_MODES).toEqual(["synthetic-noop", "coding-task"]);
    expect(actuator.CODING_TASK_KIND).toBe("github_actions_coding_task");
  });
});
