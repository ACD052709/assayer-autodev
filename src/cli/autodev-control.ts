import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

const CONTROL_VERSION = "CONTROL_TASK_V1";
const CONTROL_PLANE_URL =
  process.env.AUTODEV_CONTROL_PLANE_URL?.trim() ||
  "https://assayer-autodev-control-plane.gr8white911.workers.dev";

const SERVICE_TOKEN = process.env.AUTODEV_SERVICE_TOKEN?.trim() ?? "";

const FIXTURE_REPOSITORY = "ACD052709/assayer-autodev-coding-smoke";
const FIXTURE_COMMIT = "381ab941f224b1bf978a6d2f50c23c17df7eb8b9";
const TRUSTED_TEST_COMMAND = "node --test math.test.js";
const CONTROL_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;

const FIXTURE_RAW_BASE =
  `https://raw.githubusercontent.com/${FIXTURE_REPOSITORY}/${FIXTURE_COMMIT}`;

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonObject;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (SERVICE_TOKEN.length === 0) {
    return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
  }
  return message
    .split(SERVICE_TOKEN)
    .join("[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function authHeaders(includeJson = false): Record<string, string> {
  return {
    Authorization: `Bearer ${SERVICE_TOKEN}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

async function apiJson(
  path: string,
  input: { readonly method?: string; readonly body?: unknown } = {},
): Promise<JsonObject> {
  const response = await fetch(`${CONTROL_PLANE_URL}${path}`, {
    method: input.method ?? "GET",
    headers: authHeaders(input.body !== undefined),
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Control-plane ${input.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 800)}`,
    );
  }

  if (text.length === 0) {
    return {};
  }

  return asObject(JSON.parse(text), `Response from ${path}`);
}

async function postJson(path: string, body: unknown): Promise<JsonObject> {
  return apiJson(path, { method: "POST", body });
}

async function runPreflight(): Promise<void> {
  if (SERVICE_TOKEN.length === 0) {
    throw new Error("AUTODEV_SERVICE_TOKEN is not present in this process environment");
  }

  const dirty = git(["status", "--porcelain"]);
  if (dirty.length > 0) {
    throw new Error("AutoDev source tree is dirty; canonical control requires a committed source state");
  }

  const health = await fetch(`${CONTROL_PLANE_URL}/health`);
  if (!health.ok) {
    throw new Error(`Control-plane health failed (${health.status})`);
  }

  const authProbe = await fetch(
    `${CONTROL_PLANE_URL}/api/projects/__autodev-control-preflight__/state`,
    { headers: authHeaders() },
  );

  if (authProbe.status !== 404 && authProbe.status !== 200) {
    const body = await authProbe.text();
    throw new Error(
      `Control-plane authenticated preflight failed (${authProbe.status}): ${body.slice(0, 500)}`,
    );
  }

  const [mathResponse, htmlResponse, serverResponse] = await Promise.all([
    fetch(`${FIXTURE_RAW_BASE}/math.js`),
    fetch(`${FIXTURE_RAW_BASE}/index.html`),
    fetch(`${FIXTURE_RAW_BASE}/server.js`),
  ]);

  if (!mathResponse.ok || !htmlResponse.ok || !serverResponse.ok) {
    throw new Error("Frozen CONTROL_TASK_V1 fixture is not fully reachable");
  }

  const math = await mathResponse.text();
  if (!math.includes("return a - b;")) {
    throw new Error("Frozen CONTROL_TASK_V1 baseline no longer matches the expected known-bad fixture");
  }
}

function makeIds(): {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly testCaseId: string;
} {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const nonce = randomUUID().slice(0, 8);
  const runId = `ctrl-${timestamp}-${nonce}`;
  const projectId = `proj-${runId}`;
  const taskId = `task-${runId}`;
  const testCaseId = `tc-verify-${taskId}`;

  return { runId, projectId, taskId, testCaseId };
}

async function seedControl(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly testCaseId: string;
}): Promise<void> {
  await postJson("/api/projects", {
    id: input.projectId,
    name: "CONTROL_TASK_V1",
    description: "Frozen disposable AutoDev golden-path control.",
    targetRepository: FIXTURE_REPOSITORY,
    targetRef: FIXTURE_COMMIT,
    targetTestCommand: TRUSTED_TEST_COMMAND,
    doNotModifyConstraints: [
      "Modify math.js only.",
      "Do not modify math.test.js, index.html, or server.js.",
      "Do not perform promotion.",
      "Do not access or modify Assayer production or preview.",
    ],
  });

  await postJson(`/api/projects/${input.projectId}/budgets`, {
    resourceType: "llm_cost_usd",
    hardLimit: 10,
    unit: "usd",
  });

  await postJson("/api/tasks", {
    id: input.taskId,
    projectId: input.projectId,
    title: "Fix CONTROL_TASK_V1 addition",
    description: [
      `In the frozen disposable repository ${FIXTURE_REPOSITORY} at commit ${FIXTURE_COMMIT},`,
      "fix the existing add(a, b) implementation so that it correctly adds the two numbers.",
      "",
      "Requirements:",
      "- Make the smallest implementation change needed.",
      "- Modify math.js only.",
      "- Do not modify math.test.js, index.html, or server.js.",
      `- Run exactly: ${TRUSTED_TEST_COMMAND}`,
      "- The trusted deterministic test must pass.",
      "- Do not alter or weaken the test.",
      "- Do not perform promotion.",
      "- Do not access or modify Assayer production or preview.",
    ].join("\n"),
    kind: "implementation",
  });

  const browserSpec = {
    version: 1,
    baseUrl: "http://127.0.0.1:4173",
    cases: [
      {
        id: input.testCaseId,
        name: "CONTROL_TASK_V1 calculator returns five",
        steps: [
          { action: "navigate", url: "/" },
          { action: "assertPageLoad" },
          { action: "fill", selector: "#a", value: "2" },
          { action: "fill", selector: "#b", value: "3" },
          { action: "click", selector: "#calculate" },
          { action: "assertVisibleText", text: "Result: 5", exact: true },
        ],
      },
    ],
  };

  await postJson("/api/test-cases", {
    id: input.testCaseId,
    projectId: input.projectId,
    taskId: input.taskId,
    name: "CONTROL_TASK_V1 independent browser verification",
    description: "Independently prove that the exact candidate computes 2 + 3 as 5 in the browser.",
    kind: "browser",
    browserSpecJson: JSON.stringify(browserSpec),
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function readTask(taskId: string): Promise<JsonObject> {
  const envelope = await apiJson(`/api/tasks/${taskId}`);
  return asObject(envelope["task"], "task");
}

async function runUntilTerminal(
  projectId: string,
  taskId: string,
): Promise<{ readonly task: JsonObject; readonly timedOut: boolean }> {
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  let task = await readTask(taskId);

  while (Date.now() < deadline) {
    const cycle = await postJson(`/api/projects/${projectId}/orchestrate`, {
      runMasterReevaluation: false,
      runAudit: false,
      haltOnCriticalAudit: false,
    });

    task = await readTask(taskId);

    const phase = optionalString(cycle["phase"]) ?? "unknown";
    const status = optionalString(task["status"]) ?? "unknown";

    console.log(`${new Date().toISOString()} phase=${phase} task=${status}`);

    if (status === "completed" || status === "failed" || status === "cancelled") {
      return { task, timedOut: false };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { task, timedOut: true };
}

async function readLifecycle(
  projectId: string,
  taskId: string,
): Promise<JsonObject | undefined> {
  const audit = await postJson(`/api/projects/${projectId}/audit`, {});
  const lifecycles = audit["lifecycles"];

  if (!Array.isArray(lifecycles)) {
    return undefined;
  }

  for (const value of lifecycles) {
    const lifecycle = asObject(value, "lifecycle");
    if (lifecycle["taskId"] === taskId) {
      return lifecycle;
    }
  }

  return undefined;
}

async function saveRecord(
  runId: string,
  record: JsonObject,
): Promise<string> {
  const dir = join("dist", "autodev-control-runs");
  await mkdir(dir, { recursive: true });

  const path = join(dir, `${runId}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return path;
}

async function main(): Promise<number> {
  const ids = makeIds();
  const startedAt = new Date().toISOString();
  const autoDevCommit = git(["rev-parse", "HEAD"]);

  console.log("AUTODEV CONTROL V1");
  console.log(`run_id: ${ids.runId}`);

  try {
    await runPreflight();
    console.log("PREFLIGHT: PASS");
  } catch (error) {
    const message = safeError(error);

    const path = await saveRecord(ids.runId, {
      controlVersion: CONTROL_VERSION,
      runId: ids.runId,
      fixtureCommit: FIXTURE_COMMIT,
      autoDevCommit,
      startedAt,
      completedAt: new Date().toISOString(),
      controlResult: "PREFLIGHT_FAILED",
      error: message,
    });

    console.error(`PREFLIGHT: FAIL - ${message}`);
    console.error("CONTROL RESULT: PREFLIGHT_FAILED");
    console.error(`record: ${path}`);
    return 1;
  }

  let seeded = false;

  try {
    await seedControl(ids);
    seeded = true;

    console.log(`FIXTURE: ${CONTROL_VERSION}`);
    console.log(`fixture_commit: ${FIXTURE_COMMIT}`);
    console.log(`project_id: ${ids.projectId}`);
    console.log(`task_id: ${ids.taskId}`);

    const execution = await runUntilTerminal(ids.projectId, ids.taskId);
    const lifecycle = await readLifecycle(ids.projectId, ids.taskId);

    const auditorResult =
      lifecycle === undefined
        ? undefined
        : asObject(lifecycle["result"], "auditor result");

    const taskStatus = optionalString(execution.task["status"]) ?? "unknown";
    const auditorStatus = optionalString(auditorResult?.["status"]);

    let controlResult: "PASS" | "AUTODEV_FAILED" | "HARNESS_ERROR";

    if (lifecycle === undefined || auditorStatus === undefined) {
      controlResult = "HARNESS_ERROR";
    } else if (
      !execution.timedOut &&
      taskStatus === "completed" &&
      auditorStatus === "NO_FAILURE"
    ) {
      controlResult = "PASS";
    } else {
      controlResult = "AUTODEV_FAILED";
    }

    const path = await saveRecord(ids.runId, {
      controlVersion: CONTROL_VERSION,
      runId: ids.runId,
      fixtureCommit: FIXTURE_COMMIT,
      autoDevCommit,
      projectId: ids.projectId,
      taskId: ids.taskId,
      testCaseId: ids.testCaseId,
      startedAt,
      completedAt: new Date().toISOString(),
      timedOut: execution.timedOut,
      taskStatus,
      auditorStatus: auditorStatus ?? "MISSING",
      firstProvenFailureBoundary:
        auditorResult?.["firstProvenFailureBoundary"] ?? null,
      provenCausalEventId:
        auditorResult?.["provenCausalEventId"] ?? null,
      unknowns: auditorResult?.["unknowns"] ?? [],
      downstreamConsequences:
        auditorResult?.["downstreamConsequences"] ?? [],
      repairObserved: auditorResult?.["repairObserved"] ?? null,
      controlResult,
    });

    console.log(`EXECUTION: ${taskStatus}`);
    console.log(`AUDITOR: ${auditorStatus ?? "MISSING"}`);

    const boundary = optionalString(
      auditorResult?.["firstProvenFailureBoundary"],
    );
    if (boundary !== undefined) {
      console.log(`FIRST_PROVEN_FAILURE_BOUNDARY: ${boundary}`);
    }

    console.log(`CONTROL RESULT: ${controlResult}`);
    console.log(`record: ${path}`);

    return controlResult === "PASS" ? 0 : 1;
  } catch (error) {
    const message = safeError(error);
    let lifecycle: JsonObject | undefined;

    if (seeded) {
      try {
        lifecycle = await readLifecycle(ids.projectId, ids.taskId);
      } catch {
        lifecycle = undefined;
      }
    }

    const auditorResult =
      lifecycle === undefined
        ? undefined
        : asObject(lifecycle["result"], "auditor result");

    const auditorStatus = optionalString(auditorResult?.["status"]);
    const diagnosed =
      auditorStatus === "DIAGNOSED" ||
      auditorStatus === "INCOMPLETE_EVIDENCE" ||
      auditorStatus === "INTEGRITY_VIOLATION";

    const controlResult = diagnosed ? "AUTODEV_FAILED" : "HARNESS_ERROR";

    const path = await saveRecord(ids.runId, {
      controlVersion: CONTROL_VERSION,
      runId: ids.runId,
      fixtureCommit: FIXTURE_COMMIT,
      autoDevCommit,
      projectId: ids.projectId,
      taskId: ids.taskId,
      startedAt,
      completedAt: new Date().toISOString(),
      auditorStatus: auditorStatus ?? "MISSING",
      firstProvenFailureBoundary:
        auditorResult?.["firstProvenFailureBoundary"] ?? null,
      controlResult,
      error: message,
    });

    console.error(message);
    console.error(`CONTROL RESULT: ${controlResult}`);
    console.error(`record: ${path}`);
    return 1;
  }
}

const exitCode = await main();
process.exit(exitCode);
