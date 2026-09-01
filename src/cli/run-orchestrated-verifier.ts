import { createVerifierControlPlaneClient, persistBrowserVerification } from "../verifier/control-plane-client.js";
import { parseBrowserTestSpec } from "../verifier/browser-spec.js";
import { runBrowserSuite } from "../verifier/browser-runner.js";
import { createPlaywrightAutomation } from "../verifier/playwright-automation.js";
import { BrowserVerifierError } from "../verifier/errors.js";
import { parseCandidateRuntimeConfig, startExactCandidateRuntime } from "../verifier/candidate-runtime.js";

interface CliOptions {
  readonly verifierRunId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly testCaseId: string;
  readonly workerRunId: string;
  readonly codeCandidateId: string;
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        values.set(arg, value);
        i += 1;
      }
    }
  }
  const required = [
    "--verifier-run-id",
    "--project-id",
    "--task-id",
    "--test-case-id",
    "--worker-run-id",
    "--code-candidate-id",
  ] as const;
  for (const key of required) {
    if (!values.get(key)?.trim()) {
      throw new BrowserVerifierError("invalid_config", `Missing required ${key}`);
    }
  }
  return {
    verifierRunId: values.get("--verifier-run-id")!,
    projectId: values.get("--project-id")!,
    taskId: values.get("--task-id")!,
    testCaseId: values.get("--test-case-id")!,
    workerRunId: values.get("--worker-run-id")!,
    codeCandidateId: values.get("--code-candidate-id")!,
  };
}

function resolveControlPlaneUrl(): string {
  const url = process.env.AUTODEV_CONTROL_PLANE_URL?.trim();
  if (!url) throw new BrowserVerifierError("invalid_config", "AUTODEV_CONTROL_PLANE_URL is required");
  return url.replace(/\/+$/, "");
}

function resolveServiceToken(): string {
  const token = process.env.AUTODEV_SERVICE_TOKEN?.trim();
  if (!token) throw new BrowserVerifierError("invalid_config", "AUTODEV_SERVICE_TOKEN is required");
  return token;
}

async function completeInconclusiveBestEffort(input: {
  readonly client: ReturnType<typeof createVerifierControlPlaneClient>;
  readonly options: CliOptions;
  readonly message: string;
}): Promise<void> {
  try {
    await input.client.completeVerifierRun({
      id: input.options.verifierRunId,
      projectId: input.options.projectId,
      taskId: input.options.taskId,
      outcome: "INCONCLUSIVE",
      summary: input.message.slice(0, 500),
      evidenceIds: [],
    });
  } catch {
    // Best effort only; preserve original failure.
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const client = createVerifierControlPlaneClient({
    controlPlaneUrl: resolveControlPlaneUrl(),
    serviceToken: resolveServiceToken(),
  });

  let runtime: Awaited<ReturnType<typeof startExactCandidateRuntime>> | undefined;
  try {
    const [candidate, patchContent, testCase] = await Promise.all([
      client.getCodeCandidate(options.codeCandidateId),
      client.fetchCandidatePatch(options.codeCandidateId),
      client.getTestCase(options.testCaseId),
    ]);
    if (candidate.projectId !== options.projectId) {
      throw new BrowserVerifierError("invalid_config", "Candidate project does not match verifier inputs");
    }
    if (testCase.projectId !== options.projectId || testCase.taskId !== options.taskId) {
      throw new BrowserVerifierError("invalid_config", "Test case provenance does not match verifier inputs");
    }
    if (!testCase.browserSpecJson) {
      throw new BrowserVerifierError("invalid_config", "Registered browser test case has no deterministic browserSpecJson");
    }

    runtime = await startExactCandidateRuntime({
      candidate,
      patchContent,
      config: parseCandidateRuntimeConfig(),
    });

    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(testCase.browserSpecJson);
    } catch {
      throw new BrowserVerifierError("invalid_spec", "Stored browserSpecJson is not valid JSON");
    }
    const spec = parseBrowserTestSpec(rawSpec, runtime.baseUrl);
    if (spec.cases.length !== 1 || spec.cases[0]?.id !== options.testCaseId) {
      throw new BrowserVerifierError(
        "invalid_spec",
        `Stored browser spec must contain exactly one case with id ${options.testCaseId}`,
      );
    }

    const automation = await createPlaywrightAutomation();
    const result = await runBrowserSuite({
      spec,
      automation,
      screenshotDir: "test-artifacts/orchestrated-verifier",
    });

    await persistBrowserVerification({
      client,
      projectId: options.projectId,
      taskId: options.taskId,
      verifierRunId: options.verifierRunId,
      testCaseIdsBySpecId: { [options.testCaseId]: options.testCaseId },
      result,
      skipCreateVerifierRun: true,
      nextEvidenceId: (caseId, kind) => `ev-${options.verifierRunId}-${caseId}-${kind}`,
      nextTestResultId: (caseId) => `tr-${options.verifierRunId}-${caseId}`,
    });

    return result.outcome === "PASS" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeInconclusiveBestEffort({ client, options, message });
    throw error;
  } finally {
    await runtime?.stop();
  }
}

try {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/[\r\n]+/g, " ").slice(0, 1000));
  process.exit(1);
}
