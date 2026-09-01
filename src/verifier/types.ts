import type { VerificationOutcome } from "../domain/common.js";

export interface BrowserNetworkFailure {
  readonly url: string;
  readonly status?: number;
  readonly method?: string;
}

export interface BrowserCaseEvidence {
  readonly testCaseId: string;
  readonly testCaseName: string;
  readonly outcome: VerificationOutcome;
  readonly durationMs: number;
  readonly finalUrl: string;
  readonly consoleErrors: readonly string[];
  readonly failedNetworkRequests: readonly BrowserNetworkFailure[];
  readonly failureMessage?: string;
  readonly screenshotPath?: string;
}

export interface BrowserSuiteResult {
  readonly outcome: VerificationOutcome;
  readonly durationMs: number;
  readonly summary: string;
  readonly caseResults: readonly BrowserCaseEvidence[];
}

export interface BrowserPageSession {
  readonly finalUrl: string;
  readonly consoleErrors: readonly string[];
  readonly failedNetworkRequests: readonly BrowserNetworkFailure[];
  goto(url: string, timeoutMs: number): Promise<void>;
  assertPageLoad(timeoutMs: number): Promise<void>;
  find(input: { selector?: string; text?: string; exact?: boolean }, timeoutMs: number): Promise<void>;
  click(input: { selector?: string; text?: string; exact?: boolean }, timeoutMs: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs: number): Promise<void>;
  assertVisibleText(text: string, exact: boolean, timeoutMs: number): Promise<void>;
  assertElementVisible(selector: string, timeoutMs: number): Promise<void>;
  assertElementHidden(selector: string, timeoutMs: number): Promise<void>;
  assertChecked(selector: string, checked: boolean, timeoutMs: number): Promise<void>;
  assertEnabled(selector: string, enabled: boolean, timeoutMs: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserAutomation {
  open(baseUrl: string): Promise<BrowserPageSession>;
  close(): Promise<void>;
}
