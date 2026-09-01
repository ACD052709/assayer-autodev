export { BrowserVerifierError } from "./errors.js";
export {
  BROWSER_SPEC_VERSION,
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_SUITE_TIMEOUT_MS,
  SUPPORTED_BROWSER_ACTIONS,
  parseBrowserTestSpec,
  resolveUrl,
  type BrowserActionType,
  type BrowserStep,
  type BrowserTestCaseSpec,
  type BrowserTestSpec,
} from "./browser-spec.js";
export { runBrowserSuite, writeCaseEvidenceArtifact, type RunBrowserSuiteInput } from "./browser-runner.js";
export { createPlaywrightAutomation, PlaywrightBrowserAutomation } from "./playwright-automation.js";
export {
  createVerifierControlPlaneClient,
  persistBrowserVerification,
  runAndPersistBrowserVerification,
  type VerifierControlPlaneClient,
  type PersistBrowserVerificationInput,
  type PersistBrowserVerificationOutput,
} from "./control-plane-client.js";
export type {
  BrowserAutomation,
  BrowserCaseEvidence,
  BrowserNetworkFailure,
  BrowserPageSession,
  BrowserSuiteResult,
} from "./types.js";
