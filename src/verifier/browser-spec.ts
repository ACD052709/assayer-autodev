import { BrowserVerifierError } from "./errors.js";

export const BROWSER_SPEC_VERSION = 1 as const;

export const SUPPORTED_BROWSER_ACTIONS = [
  "navigate",
  "assertPageLoad",
  "find",
  "click",
  "fill",
  "assertVisibleText",
  "assertElementVisible",
  "assertElementHidden",
  "assertChecked",
  "assertEnabled",
] as const;

export type BrowserActionType = (typeof SUPPORTED_BROWSER_ACTIONS)[number];

export interface BrowserStepBase {
  readonly action: BrowserActionType;
  readonly timeoutMs?: number;
}

export interface NavigateStep extends BrowserStepBase {
  readonly action: "navigate";
  readonly url: string;
}

export interface AssertPageLoadStep extends BrowserStepBase {
  readonly action: "assertPageLoad";
}

export interface FindStep extends BrowserStepBase {
  readonly action: "find";
  readonly selector?: string;
  readonly text?: string;
  readonly exact?: boolean;
}

export interface ClickStep extends BrowserStepBase {
  readonly action: "click";
  readonly selector?: string;
  readonly text?: string;
  readonly exact?: boolean;
}

export interface FillStep extends BrowserStepBase {
  readonly action: "fill";
  readonly selector: string;
  readonly value: string;
}

export interface AssertVisibleTextStep extends BrowserStepBase {
  readonly action: "assertVisibleText";
  readonly text: string;
  readonly exact?: boolean;
}

export interface AssertElementVisibleStep extends BrowserStepBase {
  readonly action: "assertElementVisible";
  readonly selector: string;
}

export interface AssertElementHiddenStep extends BrowserStepBase {
  readonly action: "assertElementHidden";
  readonly selector: string;
}

export interface AssertCheckedStep extends BrowserStepBase {
  readonly action: "assertChecked";
  readonly selector: string;
  readonly checked: boolean;
}

export interface AssertEnabledStep extends BrowserStepBase {
  readonly action: "assertEnabled";
  readonly selector: string;
  readonly enabled: boolean;
}

export type BrowserStep =
  | NavigateStep
  | AssertPageLoadStep
  | FindStep
  | ClickStep
  | FillStep
  | AssertVisibleTextStep
  | AssertElementVisibleStep
  | AssertElementHiddenStep
  | AssertCheckedStep
  | AssertEnabledStep;

export interface BrowserTestCaseSpec {
  readonly id: string;
  readonly name: string;
  readonly timeoutMs?: number;
  readonly steps: readonly BrowserStep[];
}

export interface BrowserTestSpec {
  readonly version: typeof BROWSER_SPEC_VERSION;
  readonly baseUrl: string;
  readonly suiteTimeoutMs?: number;
  readonly defaultStepTimeoutMs?: number;
  readonly defaultCaseTimeoutMs?: number;
  readonly cases: readonly BrowserTestCaseSpec[];
}

export const DEFAULT_SUITE_TIMEOUT_MS = 120_000;
export const DEFAULT_CASE_TIMEOUT_MS = 30_000;
export const DEFAULT_STEP_TIMEOUT_MS = 10_000;

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserVerifierError("invalid_spec", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BrowserVerifierError("invalid_spec", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BrowserVerifierError("invalid_spec", `${field} must be a positive integer`);
  }
  return value;
}

function assertSelectorOrText(step: Record<string, unknown>, action: string): void {
  const selector = step["selector"];
  const text = step["text"];
  const hasSelector = typeof selector === "string" && selector.trim().length > 0;
  const hasText = typeof text === "string" && text.trim().length > 0;
  if (!hasSelector && !hasText) {
    throw new BrowserVerifierError("invalid_spec", `${action} requires selector or text`);
  }
  if (hasSelector && hasText) {
    throw new BrowserVerifierError("invalid_spec", `${action} accepts selector or text, not both`);
  }
}

function parseStep(raw: unknown, index: number): BrowserStep {
  const step = assertObject(raw, `cases[].steps[${index}]`);
  const action = assertNonEmptyString(step["action"], `cases[].steps[${index}].action`);
  if (!(SUPPORTED_BROWSER_ACTIONS as readonly string[]).includes(action)) {
    throw new BrowserVerifierError(
      "unsupported_action",
      `Unsupported browser action: ${action}`,
    );
  }
  const timeoutMs =
    step["timeoutMs"] === undefined ? undefined : assertPositiveInteger(step["timeoutMs"], `cases[].steps[${index}].timeoutMs`);

  const typedAction = action as BrowserActionType;

  switch (typedAction) {
    case "navigate":
      return {
        action: typedAction,
        url: assertNonEmptyString(step["url"], `cases[].steps[${index}].url`),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "assertPageLoad":
      return { action: typedAction, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    case "find":
    case "click": {
      assertSelectorOrText(step, typedAction);
      return {
        action: typedAction,
        ...(typeof step["selector"] === "string" ? { selector: step["selector"].trim() } : {}),
        ...(typeof step["text"] === "string" ? { text: step["text"].trim() } : {}),
        ...(typeof step["exact"] === "boolean" ? { exact: step["exact"] } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case "fill":
      return {
        action: typedAction,
        selector: assertNonEmptyString(step["selector"], `cases[].steps[${index}].selector`),
        value: typeof step["value"] === "string" ? step["value"] : "",
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "assertVisibleText":
      return {
        action: typedAction,
        text: assertNonEmptyString(step["text"], `cases[].steps[${index}].text`),
        ...(typeof step["exact"] === "boolean" ? { exact: step["exact"] } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "assertElementVisible":
    case "assertElementHidden":
      return {
        action: typedAction,
        selector: assertNonEmptyString(step["selector"], `cases[].steps[${index}].selector`),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "assertChecked":
      return {
        action: typedAction,
        selector: assertNonEmptyString(step["selector"], `cases[].steps[${index}].selector`),
        checked: step["checked"] === true,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "assertEnabled":
      return {
        action: typedAction,
        selector: assertNonEmptyString(step["selector"], `cases[].steps[${index}].selector`),
        enabled: step["enabled"] !== false,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    default:
      throw new BrowserVerifierError("unsupported_action", `Unsupported browser action: ${action}`);
  }
}

function parseCase(raw: unknown, index: number): BrowserTestCaseSpec {
  const item = assertObject(raw, `cases[${index}]`);
  const stepsRaw = item["steps"];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new BrowserVerifierError("invalid_spec", `cases[${index}].steps must be a non-empty array`);
  }
  return {
    id: assertNonEmptyString(item["id"], `cases[${index}].id`),
    name: assertNonEmptyString(item["name"], `cases[${index}].name`),
    ...(item["timeoutMs"] !== undefined
      ? { timeoutMs: assertPositiveInteger(item["timeoutMs"], `cases[${index}].timeoutMs`) }
      : {}),
    steps: stepsRaw.map((step, stepIndex) => parseStep(step, stepIndex)),
  };
}

export function parseBrowserTestSpec(raw: unknown, targetUrlOverride?: string): BrowserTestSpec {
  const root = assertObject(raw, "spec");
  const version = root["version"];
  if (version !== BROWSER_SPEC_VERSION) {
    throw new BrowserVerifierError("invalid_spec", `Unsupported spec version: ${String(version)}`);
  }
  const casesRaw = root["cases"];
  if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
    throw new BrowserVerifierError("invalid_spec", "spec.cases must be a non-empty array");
  }
  const baseUrl = targetUrlOverride?.trim() || assertNonEmptyString(root["baseUrl"], "baseUrl");
  return {
    version: BROWSER_SPEC_VERSION,
    baseUrl,
    ...(root["suiteTimeoutMs"] !== undefined
      ? { suiteTimeoutMs: assertPositiveInteger(root["suiteTimeoutMs"], "suiteTimeoutMs") }
      : {}),
    ...(root["defaultStepTimeoutMs"] !== undefined
      ? { defaultStepTimeoutMs: assertPositiveInteger(root["defaultStepTimeoutMs"], "defaultStepTimeoutMs") }
      : {}),
    ...(root["defaultCaseTimeoutMs"] !== undefined
      ? { defaultCaseTimeoutMs: assertPositiveInteger(root["defaultCaseTimeoutMs"], "defaultCaseTimeoutMs") }
      : {}),
    cases: casesRaw.map((item, index) => parseCase(item, index)),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1" || lower === "[::1]";
}

export function assertUrlWithinBaseOrigin(baseUrl: string, url: string): void {
  const base = new URL(baseUrl);
  const resolved = new URL(url, base);
  if (isLoopbackHost(base.hostname) && resolved.origin !== base.origin) {
    throw new BrowserVerifierError(
      "invalid_spec",
      `Loopback candidate verification cannot navigate outside ${base.origin}`,
    );
  }
}

export function resolveUrl(baseUrl: string, url: string): string {
  const resolved = new URL(url, baseUrl).toString();
  // Exact-candidate verification uses a loopback runtime. In that mode, navigation
  // must remain on the candidate origin so an absolute URL cannot produce a PASS
  // against an unrelated external deployment.
  assertUrlWithinBaseOrigin(baseUrl, resolved);
  return resolved;
}
