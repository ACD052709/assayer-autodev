import { readFile } from "node:fs/promises";
import type { EntityId, VerificationOutcome } from "../domain/common.js";
import type { Evidence } from "../domain/evidence.js";
import type { TestCase, TestResult } from "../domain/test.js";
import type { VerifierRun } from "../domain/verifier.js";
import type { CodeCandidate } from "../domain/code-candidate.js";
import type { BrowserCaseEvidence, BrowserSuiteResult } from "./types.js";

const MAX_BOOTSTRAP_BLOB_BYTES = 64 * 1024;

export interface VerifierControlPlaneClient {
  getTestCase(id: EntityId): Promise<TestCase>;
  getCodeCandidate(id: EntityId): Promise<CodeCandidate>;
  fetchCandidatePatch(id: EntityId): Promise<string>;
  createTestCase(input: {
    readonly id: EntityId;
    readonly projectId: EntityId;
    readonly taskId?: EntityId;
    readonly name: string;
    readonly description: string;
    readonly kind: "browser";
    readonly browserSpecJson?: string;
  }): Promise<TestCase>;
  createVerifierRun(input: {
    readonly id: EntityId;
    readonly projectId: EntityId;
    readonly taskId: EntityId;
    readonly codeCandidateId?: EntityId;
  }): Promise<VerifierRun>;
  completeVerifierRun(input: {
    readonly id: EntityId;
    readonly projectId: EntityId;
    readonly taskId: EntityId;
    readonly outcome: VerificationOutcome;
    readonly summary: string;
    readonly evidenceIds: readonly EntityId[];
  }): Promise<VerifierRun>;
  recordTestResult(input: {
    readonly id: EntityId;
    readonly projectId: EntityId;
    readonly testCaseId: EntityId;
    readonly taskId: EntityId;
    readonly verifierRunId: EntityId;
    readonly outcome: VerificationOutcome;
    readonly message?: string;
    readonly durationMs: number;
  }): Promise<TestResult>;
  createEvidence(input: {
    readonly id: EntityId;
    readonly projectId: EntityId;
    readonly kind: "screenshot" | "report";
    readonly label: string;
    readonly taskId: EntityId;
    readonly verifierRunId: EntityId;
    readonly mimeType?: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
    readonly blobBase64?: string;
  }): Promise<Evidence>;
}

export interface VerifierControlPlaneClientOptions {
  readonly controlPlaneUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch;
}

export function createVerifierControlPlaneClient(
  options: VerifierControlPlaneClientOptions,
): VerifierControlPlaneClient {
  const base = options.controlPlaneUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.serviceToken}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = payload["error"];
      const message =
        typeof error === "object" &&
        error !== null &&
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : `Verifier API request failed (${response.status})`;
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      throw new Error(
        `Verifier API ${method} ${path} failed (${response.status}${errorCode ? ` ${errorCode}` : ""}): ${message}`,
      );
    }
    return payload;
  }

  return {
    async getTestCase(id) {
      const payload = await requestJson("GET", `/api/test-cases/${encodeURIComponent(id)}`);
      return payload["testCase"] as TestCase;
    },
    async getCodeCandidate(id) {
      const payload = await requestJson("GET", `/api/code-candidates/${encodeURIComponent(id)}`);
      return payload["candidate"] as CodeCandidate;
    },
    async fetchCandidatePatch(id) {
      const response = await fetchImpl(`${base}/api/code-candidates/${encodeURIComponent(id)}/patch`, {
        headers: { authorization: `Bearer ${options.serviceToken}`, accept: "text/x-patch" },
      });
      if (!response.ok) throw new Error(`Failed to fetch candidate patch (${response.status})`);
      return await response.text();
    },
    async createTestCase(input) {
      const payload = await requestJson("POST", "/api/test-cases", {
        ...input,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      });
      return payload["testCase"] as TestCase;
    },
    async createVerifierRun(input) {
      const payload = await requestJson("POST", "/api/verifier-runs", input);
      return payload["verifierRun"] as VerifierRun;
    },
    async completeVerifierRun(input) {
      const payload = await requestJson("POST", "/api/verifier-runs", {
        id: input.id,
        projectId: input.projectId,
        taskId: input.taskId,
        outcome: input.outcome,
        summary: input.summary,
        evidenceIds: [...input.evidenceIds],
      });
      return payload["verifierRun"] as VerifierRun;
    },
    async recordTestResult(input) {
      const payload = await requestJson("POST", "/api/test-results", {
        ...input,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
      return payload["result"] as TestResult;
    },
    async createEvidence(input) {
      const payload = await requestJson("POST", "/api/evidence", input);
      return payload["evidence"] as Evidence;
    },
  };
}

function caseEvidenceMetadata(caseResult: BrowserCaseEvidence): Record<string, string | number | boolean> {
  return {
    testCaseId: caseResult.testCaseId,
    testCaseName: caseResult.testCaseName,
    outcome: caseResult.outcome,
    durationMs: caseResult.durationMs,
    finalUrl: caseResult.finalUrl,
    consoleErrorCount: caseResult.consoleErrors.length,
    failedNetworkRequestCount: caseResult.failedNetworkRequests.length,
    ...(caseResult.failureMessage !== undefined ? { failureMessage: caseResult.failureMessage } : {}),
    ...(caseResult.screenshotPath !== undefined ? { screenshotPath: caseResult.screenshotPath } : {}),
  };
}

export interface PersistBrowserVerificationInput {
  readonly client: VerifierControlPlaneClient;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly verifierRunId: EntityId;
  readonly testCaseIdsBySpecId: Readonly<Record<string, EntityId>>;
  readonly result: BrowserSuiteResult;
  readonly nextEvidenceId: (caseId: string, kind: string) => EntityId;
  readonly nextTestResultId: (caseId: string) => EntityId;
  /** When true, assumes verifier run already exists (orchestrator-scheduled). */
  readonly skipCreateVerifierRun?: boolean;
}

export interface PersistBrowserVerificationOutput {
  readonly verifierRun: VerifierRun;
  readonly evidenceIds: readonly EntityId[];
  readonly testResults: readonly TestResult[];
}

export async function persistBrowserVerification(
  input: PersistBrowserVerificationInput,
): Promise<PersistBrowserVerificationOutput> {
  const evidenceIds: EntityId[] = [];
  const testResults: TestResult[] = [];

  if (input.skipCreateVerifierRun !== true) {
    await input.client.createVerifierRun({
      id: input.verifierRunId,
      projectId: input.projectId,
      taskId: input.taskId,
    });
  }

  for (const caseResult of input.result.caseResults) {
    const testCaseId = input.testCaseIdsBySpecId[caseResult.testCaseId];
    if (testCaseId === undefined) {
      throw new Error(`Missing registered test case for spec id ${caseResult.testCaseId}`);
    }

    const reportEvidenceId = input.nextEvidenceId(caseResult.testCaseId, "report");
    const reportEvidence = await input.client.createEvidence({
      id: reportEvidenceId,
      projectId: input.projectId,
      kind: "report",
      label: `browser-case-${caseResult.testCaseId}`,
      taskId: input.taskId,
      verifierRunId: input.verifierRunId,
      metadata: caseEvidenceMetadata(caseResult),
    });
    evidenceIds.push(reportEvidence.id);

    if (caseResult.outcome === "FAIL" && caseResult.screenshotPath !== undefined) {
      const screenshotEvidenceId = input.nextEvidenceId(caseResult.testCaseId, "screenshot");
      let blobBase64: string | undefined;
      try {
        const bytes = await readFile(caseResult.screenshotPath);
        if (bytes.byteLength <= MAX_BOOTSTRAP_BLOB_BYTES) {
          blobBase64 = Buffer.from(bytes).toString("base64");
        }
      } catch {
        blobBase64 = undefined;
      }
      const screenshotEvidence = await input.client.createEvidence({
        id: screenshotEvidenceId,
        projectId: input.projectId,
        kind: "screenshot",
        label: `browser-failure-${caseResult.testCaseId}`,
        taskId: input.taskId,
        verifierRunId: input.verifierRunId,
        mimeType: "image/png",
        metadata: {
          testCaseId: caseResult.testCaseId,
          ...(blobBase64 === undefined ? { screenshotPath: caseResult.screenshotPath } : {}),
        },
        ...(blobBase64 !== undefined ? { blobBase64 } : {}),
      });
      evidenceIds.push(screenshotEvidence.id);
    }

    const testResult = await input.client.recordTestResult({
      id: input.nextTestResultId(caseResult.testCaseId),
      projectId: input.projectId,
      testCaseId,
      taskId: input.taskId,
      verifierRunId: input.verifierRunId,
      outcome: caseResult.outcome,
      durationMs: caseResult.durationMs,
      ...(caseResult.failureMessage !== undefined ? { message: caseResult.failureMessage } : {}),
    });
    testResults.push(testResult);
  }

  const verifierRun = await input.client.completeVerifierRun({
    id: input.verifierRunId,
    projectId: input.projectId,
    taskId: input.taskId,
    outcome: input.result.outcome,
    summary: input.result.summary,
    evidenceIds,
  });

  return { verifierRun, evidenceIds, testResults };
}

export async function runAndPersistBrowserVerification(input: {
  readonly client: VerifierControlPlaneClient;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly verifierRunId: EntityId;
  readonly testCaseIdsBySpecId: Readonly<Record<string, EntityId>>;
  readonly result: BrowserSuiteResult;
  readonly nextEvidenceId: (caseId: string, kind: string) => EntityId;
  readonly nextTestResultId: (caseId: string) => EntityId;
}): Promise<PersistBrowserVerificationOutput> {
  return persistBrowserVerification(input);
}
