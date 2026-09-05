import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeCandidateIdForWorkerRun } from "../domain/code-candidate.js";
import { sha256Hex } from "../security/checksum.js";

type JsonObject = Record<string, unknown>;

const CONTROL_VERSION = "CONTROL_REPAIR_V1";

const CONTROL_PLANE_URL =
  process.env.AUTODEV_CONTROL_PLANE_URL?.trim() ||
  "https://assayer-autodev-control-plane.gr8white911.workers.dev";

const SERVICE_TOKEN = process.env.AUTODEV_SERVICE_TOKEN?.trim() ?? "";

const FIXTURE_REPOSITORY = "ACD052709/assayer-autodev-coding-smoke";
const FIXTURE_COMMIT = "381ab941f224b1bf978a6d2f50c23c17df7eb8b9";
const TRUSTED_TEST_COMMAND = "node --test math.test.js";

const CONTROL_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;

const FIXTURE_RAW_BASE =
  `https://raw.githubusercontent.com/${FIXTURE_REPOSITORY}/${FIXTURE_COMMIT}`;

const BAD_PATCH =
  [
    "diff --git a/math.js b/math.js",
    "--- a/math.js",
    "+++ b/math.js",
    "@@ -1,3 +1,6 @@",
    " function add(a, b) {",
    "-  return a - b;",
    '+  if (typeof window !== "undefined") {',
    "+    return a - b;",
    "+  }",
    "+  return a + b;",
    " }",
    "",
  ].join("\n");

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): string {
  try {
    return execFileSync(command, [...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}: ${safeError(error)}`,
    );
  }
}

function git(args: readonly string[], cwd?: string): string {
  return runCommand("git", args, cwd);
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
    ...(input.body !== undefined
      ? { body: JSON.stringify(input.body) }
      : {}),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Control-plane ${input.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 1000)}`,
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

async function proveBadCandidateTrustedTest(): Promise<void> {
  const root = await mkdtemp(
    join(tmpdir(), "assayer-autodev-repair-control-"),
  );
  const checkout = join(root, "fixture");
  const patchPath = join(root, "known-bad.patch");

  try {
    runCommand(
      "git",
      [
        "clone",
        "--quiet",
        "--no-checkout",
        `https://github.com/${FIXTURE_REPOSITORY}.git`,
        checkout,
      ],
    );

    git(
      ["checkout", "--detach", "--quiet", FIXTURE_COMMIT],
      checkout,
    );

    await writeFile(patchPath, BAD_PATCH, "utf8");

    git(["apply", "--check", patchPath], checkout);
    git(["apply", patchPath], checkout);

    const changedFiles = git(["diff", "--name-only"], checkout)
      .split(/\r?\n/)
      .filter((value) => value.length > 0);

    if (
      changedFiles.length !== 1 ||
      changedFiles[0] !== "math.js"
    ) {
      throw new Error(
        `Known-bad local candidate changed unexpected files: ${changedFiles.join(", ")}`,
      );
    }

    runCommand("node", ["--test", "math.test.js"], checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runPreflight(): Promise<void> {
  if (SERVICE_TOKEN.length === 0) {
    throw new Error(
      "AUTODEV_SERVICE_TOKEN is not present in this process environment",
    );
  }

  const dirty = git(["status", "--porcelain"]);

  if (dirty.length > 0) {
    throw new Error(
      "AutoDev source tree is dirty; repair control requires committed source",
    );
  }

  const health = await fetch(`${CONTROL_PLANE_URL}/health`);

  if (!health.ok) {
    throw new Error(
      `Control-plane health failed (${health.status})`,
    );
  }

  const authProbe = await fetch(
    `${CONTROL_PLANE_URL}/api/projects/proj-autodev-repair-control-preflight/state`,
    { headers: authHeaders() },
  );

  if (authProbe.status !== 404 && authProbe.status !== 200) {
    const body = await authProbe.text();
    throw new Error(
      `Authenticated preflight failed (${authProbe.status}): ${body.slice(0, 500)}`,
    );
  }

  const [mathResponse, htmlResponse, serverResponse] =
    await Promise.all([
      fetch(`${FIXTURE_RAW_BASE}/math.js`),
      fetch(`${FIXTURE_RAW_BASE}/index.html`),
      fetch(`${FIXTURE_RAW_BASE}/server.js`),
    ]);

  if (
    !mathResponse.ok ||
    !htmlResponse.ok ||
    !serverResponse.ok
  ) {
    throw new Error(
      "Frozen CONTROL_REPAIR_V1 fixture is not fully reachable",
    );
  }

  const math = await mathResponse.text();

  if (!math.includes("return a - b;")) {
    throw new Error(
      "Frozen fixture no longer contains the expected subtraction baseline",
    );
  }

  await proveBadCandidateTrustedTest();
}

function makeIds(): {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly testCaseId: string;
  readonly ownerId: string;
} {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const nonce = randomUUID().slice(0, 8);

  const runId = `rctrl-${timestamp}-${nonce}`;
  const projectId = `proj-${runId}`;
  const taskId = `task-${runId}`;
  const testCaseId = `tc-verify-${taskId}`;
  const ownerId = `owner-${runId}`;

  return {
    runId,
    projectId,
    taskId,
    testCaseId,
    ownerId,
  };
}

async function seedControl(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly testCaseId: string;
}): Promise<void> {
  await postJson("/api/projects", {
    id: input.projectId,
    name: CONTROL_VERSION,
    description:
      "Disposable deterministic AutoDev FAIL-to-REPAIR-to-PASS control.",
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

  await postJson(
    `/api/projects/${input.projectId}/budgets`,
    {
      resourceType: "llm_cost_usd",
      hardLimit: 10,
      unit: "usd",
    },
  );

  await postJson("/api/tasks", {
    id: input.taskId,
    projectId: input.projectId,
    title: "Repair CONTROL_REPAIR_V1 addition",
    description: [
      `In the frozen disposable repository ${FIXTURE_REPOSITORY} at commit ${FIXTURE_COMMIT},`,
      "make add(a, b) correctly add the two numbers in all supported execution environments.",
      "",
      "Requirements:",
      "- Make the smallest implementation change needed.",
      "- Modify math.js only.",
      "- Do not modify math.test.js, index.html, or server.js.",
      `- Run exactly: ${TRUSTED_TEST_COMMAND}`,
      "- The trusted deterministic test must pass.",
      "- Browser behavior must also correctly compute 2 + 3 as 5.",
      "- Do not alter or weaken any test.",
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
        name: "CONTROL_REPAIR_V1 calculator returns five",
        steps: [
          { action: "navigate", url: "/" },
          { action: "assertPageLoad" },
          { action: "fill", selector: "#a", value: "2" },
          { action: "fill", selector: "#b", value: "3" },
          { action: "click", selector: "#calculate" },
          {
            action: "assertVisibleText",
            text: "Result: 5",
            exact: true,
          },
        ],
      },
    ],
  };

  await postJson("/api/test-cases", {
    id: input.testCaseId,
    projectId: input.projectId,
    taskId: input.taskId,
    name: "CONTROL_REPAIR_V1 independent browser verification",
    description:
      "Independently prove that the exact candidate computes 2 + 3 as 5 in the browser.",
    kind: "browser",
    browserSpecJson: JSON.stringify(browserSpec),
  });
}

async function seedKnownBadCandidate(input: {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly ownerId: string;
}): Promise<{
  readonly initialWorkerRunId: string;
  readonly initialCandidateId: string;
}> {
  const dispatch = await postJson(
    `/api/projects/${input.projectId}/dispatch`,
    {
      maxAssignments: 1,
      launchWorkers: false,
    },
  );

  const assignments = asArray(
    dispatch["assignments"],
    "dispatch assignments",
  );

  const launches = asArray(
    dispatch["launches"],
    "dispatch launches",
  );

  if (assignments.length !== 1) {
    throw new Error(
      `Expected exactly one initial assignment; got ${assignments.length}`,
    );
  }

  if (launches.length !== 0) {
    throw new Error(
      "Initial controlled assignment unexpectedly launched a worker",
    );
  }

  const assignment = asObject(
    assignments[0],
    "initial assignment",
  );

  const workerRun = asObject(
    assignment["workerRun"],
    "initial workerRun",
  );

  const assignedTask = asObject(
    assignment["task"],
    "initial assigned task",
  );

  const initialWorkerRunId = requiredString(
    workerRun["id"],
    "initial worker run id",
  );

  if (assignedTask["id"] !== input.taskId) {
    throw new Error(
      "Controlled dispatch assigned the wrong task",
    );
  }

  if (assignedTask["status"] !== "assigned") {
    throw new Error(
      `Controlled task was not assigned; status=${String(assignedTask["status"])}`,
    );
  }

  const claim = await postJson(
    `/api/worker-runs/${initialWorkerRunId}/claim`,
    {
      ownerId: input.ownerId,
    },
  );

  if (claim["claimed"] !== true) {
    throw new Error(
      "Initial controlled worker run was not claimable",
    );
  }

  const leaseToken = requiredString(
    claim["leaseToken"],
    "initial lease token",
  );

  const initialCandidateId =
    codeCandidateIdForWorkerRun(
      input.taskId,
      initialWorkerRunId,
    );

  await postJson("/api/code-candidates", {
    id: initialCandidateId,
    projectId: input.projectId,
    taskId: input.taskId,
    workerRunId: initialWorkerRunId,
    sourceRepository: FIXTURE_REPOSITORY,
    sourceRef: FIXTURE_COMMIT,
    baseCommitSha: FIXTURE_COMMIT,
    changedFiles: ["math.js"],
    patchChecksumSha256: sha256Hex(BAD_PATCH),
    patchBase64: Buffer.from(BAD_PATCH, "utf8").toString(
      "base64",
    ),
    testCommand: TRUSTED_TEST_COMMAND,
    testExitCode: 0,
  });

  const succeeded = await postJson(
    `/api/worker-runs/${initialWorkerRunId}/succeed`,
    {
      summary:
        "Deterministic seeded candidate completed with trusted Node test exit code 0.",
      leaseToken,
    },
  );

  const succeededTask = asObject(
    succeeded["task"],
    "task after seeded worker success",
  );

  if (
    succeededTask["status"] !== "awaiting_verification"
  ) {
    throw new Error(
      `Seeded task did not enter awaiting_verification; status=${String(succeededTask["status"])}`,
    );
  }

  return {
    initialWorkerRunId,
    initialCandidateId,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function readTask(
  taskId: string,
): Promise<JsonObject> {
  const envelope = await apiJson(
    `/api/tasks/${taskId}`,
  );

  return asObject(envelope["task"], "task");
}

async function runUntilTerminal(
  projectId: string,
  taskId: string,
): Promise<{
  readonly task: JsonObject;
  readonly timedOut: boolean;
}> {
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  let task = await readTask(taskId);

  while (Date.now() < deadline) {
    const cycle = await postJson(
      `/api/projects/${projectId}/orchestrate`,
      {
        runMasterReevaluation: false,
        runAudit: false,
        haltOnCriticalAudit: false,
      },
    );

    task = await readTask(taskId);

    const phase =
      optionalString(cycle["phase"]) ?? "unknown";

    const status =
      optionalString(task["status"]) ?? "unknown";

    console.log(
      `${new Date().toISOString()} phase=${phase} task=${status}`,
    );

    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
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
  const audit = await postJson(
    `/api/projects/${projectId}/audit`,
    {},
  );

  const lifecycles = audit["lifecycles"];

  if (!Array.isArray(lifecycles)) {
    return undefined;
  }

  for (const value of lifecycles) {
    const lifecycle = asObject(
      value,
      "lifecycle",
    );

    if (lifecycle["taskId"] === taskId) {
      return lifecycle;
    }
  }

  return undefined;
}

async function readCandidate(
  candidateId: string,
): Promise<JsonObject> {
  const envelope = await apiJson(
    `/api/code-candidates/${candidateId}`,
  );

  return asObject(
    envelope["candidate"],
    `candidate ${candidateId}`,
  );
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  const actual = asArray(value, label);

  if (
    actual.length !== expected.length ||
    actual.some(
      (entry, index) => entry !== expected[index],
    )
  ) {
    throw new Error(
      `${label} mismatch: ${JSON.stringify(actual)}`,
    );
  }
}

async function assertFinalProof(input: {
  readonly execution: {
    readonly task: JsonObject;
    readonly timedOut: boolean;
  };
  readonly auditorResult: JsonObject;
  readonly originalTaskId: string;
  readonly initialWorkerRunId: string;
  readonly initialCandidateId: string;
}): Promise<{
  readonly repairedCandidateId: string;
  readonly repairedWorkerRunId: string;
  readonly verifierOutcomes: readonly string[];
}> {
  if (input.execution.timedOut) {
    throw new Error(
      "CONTROL_REPAIR_V1 timed out",
    );
  }

  if (input.execution.task["status"] !== "completed") {
    throw new Error(
      `Original task did not complete; status=${String(input.execution.task["status"])}`,
    );
  }

  if (input.auditorResult["status"] !== "NO_FAILURE") {
    throw new Error(
      `Final auditor status is ${String(input.auditorResult["status"])} instead of NO_FAILURE`,
    );
  }

  if (input.auditorResult["repairObserved"] !== true) {
    throw new Error(
      "Auditor did not observe the repair lifecycle",
    );
  }

  const integrityFindings = asArray(
    input.auditorResult["integrityFindings"],
    "integrityFindings",
  );

  if (integrityFindings.length !== 0) {
    throw new Error(
      `Auditor reported integrity findings: ${JSON.stringify(integrityFindings)}`,
    );
  }

  const unknowns = asArray(
    input.auditorResult["unknowns"],
    "unknowns",
  );

  if (unknowns.length !== 0) {
    throw new Error(
      `Auditor retained unknowns: ${JSON.stringify(unknowns)}`,
    );
  }

  const lineage = asArray(
    input.auditorResult["candidateLineage"],
    "candidateLineage",
  );

  if (lineage.length !== 2) {
    throw new Error(
      `Expected exactly two candidates; got ${lineage.length}`,
    );
  }

  const initialTransition = asObject(
    lineage[0],
    "initial candidate transition",
  );

  const repairTransition = asObject(
    lineage[1],
    "repair candidate transition",
  );

  const firstCandidateId = requiredString(
    initialTransition["codeCandidateId"],
    "first candidate id",
  );

  if (
    firstCandidateId !== input.initialCandidateId
  ) {
    throw new Error(
      "Auditor first candidate does not match seeded known-bad candidate",
    );
  }

  const repairedCandidateId = requiredString(
    repairTransition["codeCandidateId"],
    "repaired candidate id",
  );

  if (
    repairTransition["parentCodeCandidateId"] !==
    input.initialCandidateId
  ) {
    throw new Error(
      "Repaired candidate is not bound to the rejected parent",
    );
  }

  if (
    repairedCandidateId === input.initialCandidateId
  ) {
    throw new Error(
      "Repair did not produce a distinct child candidate",
    );
  }

  const verificationEntries = asArray(
    input.auditorResult["verifications"],
    "verifications",
  );

  if (verificationEntries.length !== 2) {
    throw new Error(
      `Expected exactly two completed verifications; got ${verificationEntries.length}`,
    );
  }

  const firstVerification = asObject(
    verificationEntries[0],
    "first verification",
  );

  const secondVerification = asObject(
    verificationEntries[1],
    "second verification",
  );

  if (
    firstVerification["outcome"] !== "FAIL" ||
    firstVerification["codeCandidateId"] !==
      input.initialCandidateId
  ) {
    throw new Error(
      "First independent verification was not FAIL on the seeded candidate",
    );
  }

  if (
    secondVerification["outcome"] !== "PASS" ||
    secondVerification["codeCandidateId"] !==
      repairedCandidateId
  ) {
    throw new Error(
      "Second independent verification was not PASS on the repaired child candidate",
    );
  }

  const initialCandidate = await readCandidate(
    input.initialCandidateId,
  );

  const repairedCandidate = await readCandidate(
    repairedCandidateId,
  );

  exactStringArray(
    initialCandidate["changedFiles"],
    ["math.js"],
    "initial candidate changedFiles",
  );

  exactStringArray(
    repairedCandidate["changedFiles"],
    ["math.js"],
    "repaired candidate changedFiles",
  );

  if (
    repairedCandidate["parentCandidateId"] !==
    input.initialCandidateId
  ) {
    throw new Error(
      "Persisted repaired candidate parentCandidateId is incorrect",
    );
  }

  if (
    repairedCandidate["taskId"] === input.originalTaskId
  ) {
    throw new Error(
      "Repaired candidate was not produced by a distinct repair task",
    );
  }

  const repairedWorkerRunId = requiredString(
    repairedCandidate["workerRunId"],
    "repaired worker run id",
  );

  if (
    repairedWorkerRunId === input.initialWorkerRunId
  ) {
    throw new Error(
      "Repair reused the seeded worker run instead of executing a repair worker",
    );
  }

  for (const [label, candidate] of [
    ["initial", initialCandidate],
    ["repaired", repairedCandidate],
  ] as const) {
    if (
      candidate["sourceRepository"] !==
      FIXTURE_REPOSITORY
    ) {
      throw new Error(
        `${label} candidate repository drifted`,
      );
    }

    if (candidate["sourceRef"] !== FIXTURE_COMMIT) {
      throw new Error(
        `${label} candidate source ref drifted`,
      );
    }

    if (
      candidate["baseCommitSha"] !== FIXTURE_COMMIT
    ) {
      throw new Error(
        `${label} candidate base commit drifted`,
      );
    }

    if (
      candidate["testCommand"] !==
      TRUSTED_TEST_COMMAND
    ) {
      throw new Error(
        `${label} candidate test command drifted`,
      );
    }

    if (candidate["testExitCode"] !== 0) {
      throw new Error(
        `${label} candidate trusted test did not pass`,
      );
    }
  }

  return {
    repairedCandidateId,
    repairedWorkerRunId,
    verifierOutcomes: ["FAIL", "PASS"],
  };
}

async function saveRecord(
  runId: string,
  record: JsonObject,
): Promise<string> {
  const dir = join(
    "dist",
    "autodev-repair-control-runs",
  );

  await mkdir(dir, { recursive: true });

  const path = join(dir, `${runId}.json`);

  await writeFile(
    path,
    `${JSON.stringify(record, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );

  return path;
}

async function main(): Promise<number> {
  const ids = makeIds();
  const startedAt = new Date().toISOString();
  const autoDevCommit = git(["rev-parse", "HEAD"]);

  console.log("AUTODEV REPAIR CONTROL V1");
  console.log(`run_id: ${ids.runId}`);

  try {
    await runPreflight();
    console.log("PREFLIGHT: PASS");
    console.log(
      "KNOWN_BAD_TRUSTED_TEST: PASS",
    );
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

    console.error(
      `PREFLIGHT: FAIL - ${message}`,
    );
    console.error(
      "CONTROL RESULT: PREFLIGHT_FAILED",
    );
    console.error(`record: ${path}`);

    return 1;
  }

  let seeded = false;
  let initialWorkerRunId: string | undefined;
  let initialCandidateId: string | undefined;

  try {
    await seedControl(ids);
    seeded = true;

    console.log(`FIXTURE: ${CONTROL_VERSION}`);
    console.log(
      `fixture_commit: ${FIXTURE_COMMIT}`,
    );
    console.log(
      `project_id: ${ids.projectId}`,
    );
    console.log(`task_id: ${ids.taskId}`);

    const seededCandidate =
      await seedKnownBadCandidate(ids);

    initialWorkerRunId =
      seededCandidate.initialWorkerRunId;

    initialCandidateId =
      seededCandidate.initialCandidateId;

    console.log(
      `initial_worker_run_id: ${initialWorkerRunId}`,
    );
    console.log(
      `initial_candidate_id: ${initialCandidateId}`,
    );
    console.log(
      "INITIAL_LAUNCH_SUPPRESSED: PASS",
    );

    const execution = await runUntilTerminal(
      ids.projectId,
      ids.taskId,
    );

    const lifecycle = await readLifecycle(
      ids.projectId,
      ids.taskId,
    );

    if (lifecycle === undefined) {
      throw new Error(
        "Persisted auditor lifecycle is missing",
      );
    }

    const auditorResult = asObject(
      lifecycle["result"],
      "auditor result",
    );

    const proof = await assertFinalProof({
      execution,
      auditorResult,
      originalTaskId: ids.taskId,
      initialWorkerRunId,
      initialCandidateId,
    });

    const path = await saveRecord(ids.runId, {
      controlVersion: CONTROL_VERSION,
      runId: ids.runId,
      fixtureCommit: FIXTURE_COMMIT,
      autoDevCommit,
      projectId: ids.projectId,
      taskId: ids.taskId,
      testCaseId: ids.testCaseId,
      initialWorkerRunId,
      initialCandidateId,
      repairedWorkerRunId:
        proof.repairedWorkerRunId,
      repairedCandidateId:
        proof.repairedCandidateId,
      verifierOutcomes:
        proof.verifierOutcomes,
      startedAt,
      completedAt: new Date().toISOString(),
      timedOut: execution.timedOut,
      taskStatus: execution.task["status"],
      auditorStatus:
        auditorResult["status"],
      repairObserved:
        auditorResult["repairObserved"],
      integrityFindings:
        auditorResult["integrityFindings"],
      unknowns: auditorResult["unknowns"],
      candidateLineage:
        auditorResult["candidateLineage"],
      verifications:
        auditorResult["verifications"],
      controlResult: "PASS",
    });

    console.log(
      "FIRST VERIFIER: FAIL",
    );
    console.log(
      "REPAIR OBSERVED: true",
    );
    console.log(
      `REPAIRED CANDIDATE: ${proof.repairedCandidateId}`,
    );
    console.log(
      "SECOND VERIFIER: PASS",
    );
    console.log(
      "EXECUTION: completed",
    );
    console.log(
      "AUDITOR: NO_FAILURE",
    );
    console.log(
      "CONTROL RESULT: PASS",
    );
    console.log(`record: ${path}`);

    return 0;
  } catch (error) {
    const message = safeError(error);

    let lifecycle: JsonObject | undefined;

    if (seeded) {
      try {
        lifecycle = await readLifecycle(
          ids.projectId,
          ids.taskId,
        );
      } catch {
        lifecycle = undefined;
      }
    }

    const auditorResult =
      lifecycle === undefined
        ? undefined
        : asObject(
            lifecycle["result"],
            "auditor result",
          );

    const path = await saveRecord(ids.runId, {
      controlVersion: CONTROL_VERSION,
      runId: ids.runId,
      fixtureCommit: FIXTURE_COMMIT,
      autoDevCommit,
      projectId: ids.projectId,
      taskId: ids.taskId,
      testCaseId: ids.testCaseId,
      ...(initialWorkerRunId !== undefined
        ? { initialWorkerRunId }
        : {}),
      ...(initialCandidateId !== undefined
        ? { initialCandidateId }
        : {}),
      startedAt,
      completedAt: new Date().toISOString(),
      auditorStatus:
        auditorResult?.["status"] ?? "MISSING",
      repairObserved:
        auditorResult?.["repairObserved"] ?? null,
      integrityFindings:
        auditorResult?.["integrityFindings"] ?? [],
      unknowns:
        auditorResult?.["unknowns"] ?? [],
      candidateLineage:
        auditorResult?.["candidateLineage"] ?? [],
      verifications:
        auditorResult?.["verifications"] ?? [],
      controlResult:
        seeded
          ? "AUTODEV_FAILED"
          : "HARNESS_ERROR",
      error: message,
    });

    console.error(message);
    console.error(
      `CONTROL RESULT: ${seeded ? "AUTODEV_FAILED" : "HARNESS_ERROR"}`,
    );
    console.error(`record: ${path}`);

    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
