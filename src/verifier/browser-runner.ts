import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_SUITE_TIMEOUT_MS,
  assertUrlWithinBaseOrigin,
  resolveUrl,
  type BrowserStep,
  type BrowserTestCaseSpec,
  type BrowserTestSpec,
} from "./browser-spec.js";
import type { BrowserAutomation, BrowserCaseEvidence, BrowserPageSession, BrowserSuiteResult } from "./types.js";

export interface RunBrowserSuiteInput {
  readonly spec: BrowserTestSpec;
  readonly automation: BrowserAutomation;
  readonly screenshotDir?: string;
  readonly now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function executeStep(
  session: BrowserPageSession,
  step: BrowserStep,
  spec: BrowserTestSpec,
): Promise<void> {
  const timeoutMs = step.timeoutMs ?? spec.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  switch (step.action) {
    case "navigate":
      await session.goto(resolveUrl(spec.baseUrl, step.url), timeoutMs);
      return;
    case "assertPageLoad":
      await session.assertPageLoad(timeoutMs);
      return;
    case "find":
      await session.find(
        {
          ...(step.selector !== undefined ? { selector: step.selector } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.exact !== undefined ? { exact: step.exact } : {}),
        },
        timeoutMs,
      );
      return;
    case "click":
      await session.click(
        {
          ...(step.selector !== undefined ? { selector: step.selector } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.exact !== undefined ? { exact: step.exact } : {}),
        },
        timeoutMs,
      );
      return;
    case "fill":
      await session.fill(step.selector, step.value, timeoutMs);
      return;
    case "assertVisibleText":
      await session.assertVisibleText(step.text, step.exact ?? false, timeoutMs);
      return;
    case "assertElementVisible":
      await session.assertElementVisible(step.selector, timeoutMs);
      return;
    case "assertElementHidden":
      await session.assertElementHidden(step.selector, timeoutMs);
      return;
    case "assertChecked":
      await session.assertChecked(step.selector, step.checked, timeoutMs);
      return;
    case "assertEnabled":
      await session.assertEnabled(step.selector, step.enabled, timeoutMs);
      return;
    default:
      throw new Error(`Unsupported browser action: ${(step as BrowserStep).action}`);
  }
}

async function runCase(
  spec: BrowserTestSpec,
  testCase: BrowserTestCaseSpec,
  automation: BrowserAutomation,
  screenshotDir: string,
): Promise<BrowserCaseEvidence> {
  const startedAt = Date.now();
  let session: BrowserPageSession | undefined;
  try {
    session = await automation.open(spec.baseUrl);
    for (const step of testCase.steps) {
      await executeStep(session, step, spec);
      // Clicks and application redirects can navigate just as explicitly as a
      // navigate step. Keep exact-candidate loopback verification pinned to the
      // candidate origin after every interaction.
      assertUrlWithinBaseOrigin(spec.baseUrl, session.finalUrl);
    }
    return {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      outcome: "PASS",
      durationMs: Date.now() - startedAt,
      finalUrl: session.finalUrl,
      consoleErrors: [...session.consoleErrors],
      failedNetworkRequests: [...session.failedNetworkRequests],
    };
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : "Browser test case failed";
    let screenshotPath: string | undefined;
    if (session !== undefined) {
      screenshotPath = join(screenshotDir, `${testCase.id}.png`);
      try {
        await session.screenshot(screenshotPath);
      } catch {
        screenshotPath = undefined;
      }
    }
    return {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      outcome: "FAIL",
      durationMs: Date.now() - startedAt,
      finalUrl: session?.finalUrl ?? spec.baseUrl,
      consoleErrors: session ? [...session.consoleErrors] : [],
      failedNetworkRequests: session ? [...session.failedNetworkRequests] : [],
      failureMessage,
      ...(screenshotPath !== undefined ? { screenshotPath } : {}),
    };
  } finally {
    if (session !== undefined) {
      await session.close();
    }
  }
}

export async function runBrowserSuite(input: RunBrowserSuiteInput): Promise<BrowserSuiteResult> {
  const startedAt = input.now?.() ?? Date.now();
  const screenshotDir = input.screenshotDir ?? join(tmpdir(), "assayer-browser-verifier");
  await mkdir(screenshotDir, { recursive: true });

  const suiteTimeoutMs = input.spec.suiteTimeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS;
  const caseTimeoutMsDefault = input.spec.defaultCaseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;

  const caseResults: BrowserCaseEvidence[] = [];
  try {
    await withTimeout(
      (async () => {
        for (const testCase of input.spec.cases) {
          const caseTimeoutMs = testCase.timeoutMs ?? caseTimeoutMsDefault;
          const result = await withTimeout(
            runCase(input.spec, testCase, input.automation, screenshotDir),
            caseTimeoutMs,
            `Test case ${testCase.id}`,
          );
          caseResults.push(result);
          if (result.outcome === "FAIL") {
            break;
          }
        }
      })(),
      suiteTimeoutMs,
      "Browser suite",
    );
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : "Browser suite failed";
    if (caseResults.length < input.spec.cases.length) {
      const pending = input.spec.cases[caseResults.length]!;
      caseResults.push({
        testCaseId: pending.id,
        testCaseName: pending.name,
        outcome: "FAIL",
        durationMs: 0,
        finalUrl: input.spec.baseUrl,
        consoleErrors: [],
        failedNetworkRequests: [],
        failureMessage,
      });
    }
  } finally {
    await input.automation.close();
  }

  const failed = caseResults.find((result) => result.outcome === "FAIL");
  const outcome = failed === undefined ? "PASS" : "FAIL";
  const summary =
    outcome === "PASS"
      ? `All ${caseResults.length} browser test case(s) passed`
      : `Browser verification failed at ${failed!.testCaseId}: ${failed!.failureMessage ?? "unknown failure"}`;

  return {
    outcome,
    durationMs: (input.now?.() ?? Date.now()) - startedAt,
    summary,
    caseResults,
  };
}

export async function writeCaseEvidenceArtifact(
  dir: string,
  caseResult: BrowserCaseEvidence,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${caseResult.testCaseId}.json`);
  await writeFile(path, JSON.stringify(caseResult, null, 2), "utf8");
  return path;
}
