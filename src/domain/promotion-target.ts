import type { Project } from "./project.js";

const FORBIDDEN_REPOSITORY_PATTERNS = [
  /^assayer\/.+$/i,
  /\/assayer$/i,
  /\/assayer-production$/i,
  /\/assayer-preview$/i,
];

const FORBIDDEN_REF_EXACT = new Set([
  "main",
  "master",
  "production",
  "prod",
  "release",
  "develop",
  "staging",
]);

const FORBIDDEN_REF_PREFIXES = ["refs/heads/main", "refs/heads/master", "release/"];

export class PromotionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionTargetError";
  }
}

export function normalizeRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  return trimmed;
}

export function assertPromotionRepositoryAllowed(repository: string): void {
  const normalized = repository.trim();
  if (normalized.length === 0) {
    throw new PromotionTargetError("Promotion repository is required");
  }
  for (const pattern of FORBIDDEN_REPOSITORY_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new PromotionTargetError(`Promotion repository is forbidden: ${normalized}`);
    }
  }
}

export function assertPromotionRefAllowed(ref: string): void {
  const normalized = normalizeRef(ref);
  const lower = normalized.toLowerCase();
  if (FORBIDDEN_REF_EXACT.has(lower)) {
    throw new PromotionTargetError(`Promotion ref is forbidden: ${normalized}`);
  }
  for (const prefix of FORBIDDEN_REF_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      throw new PromotionTargetError(`Promotion ref is forbidden: ${normalized}`);
    }
  }
  if (
    lower.includes("..") ||
    lower.startsWith("/") ||
    lower.endsWith("/") ||
    lower.includes("//") ||
    lower.includes("@{") ||
    /[\x00-\x20\x7f~^:?*\[\]\\]/.test(normalized) ||
    normalized.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  ) {
    throw new PromotionTargetError(`Promotion ref is invalid: ${normalized}`);
  }
}

export function assertPromotionRefPrefixAllowed(prefix: string): void {
  const normalized = normalizeRef(prefix);
  if (normalized.length === 0) {
    throw new PromotionTargetError("Promotion ref prefix is required");
  }
  // Validate the prefix through an actual branch-shaped ref so the same policy
  // used at promotion time also protects project configuration.
  assertPromotionRefAllowed(`${normalized}/probe-task`);
}

export function defaultPromotionRef(taskId: string, prefix = "autodev"): string {
  return `${prefix}/${taskId}`;
}

export function resolvePromotionDestination(input: {
  readonly project: Pick<Project, "targetRepository" | "promotionRepository" | "promotionRefPrefix">;
  readonly taskId: string;
}): { readonly repository: string; readonly ref: string } {
  const repository = input.project.promotionRepository ?? input.project.targetRepository;
  if (repository === undefined) {
    throw new PromotionTargetError("Project has no promotion or target repository configured");
  }
  if (
    input.project.promotionRepository !== undefined &&
    input.project.targetRepository !== undefined &&
    input.project.promotionRepository !== input.project.targetRepository
  ) {
    throw new PromotionTargetError("Cross-repository promotion is not supported");
  }
  assertPromotionRepositoryAllowed(repository);
  const ref = defaultPromotionRef(input.taskId, input.project.promotionRefPrefix ?? "autodev");
  assertPromotionRefAllowed(ref);
  return { repository, ref };
}

export function buildDeterministicCommitMessage(input: {
  readonly taskId: string;
  readonly workerRunId: string;
  readonly verifierRunId: string;
  readonly codeCandidateId: string;
  readonly patchChecksumSha256: string;
}): string {
  return [
    "autodev: promote verified candidate",
    "",
    `task=${input.taskId}`,
    `worker=${input.workerRunId}`,
    `verifier=${input.verifierRunId}`,
    `candidate=${input.codeCandidateId}`,
    `patch-sha256=${input.patchChecksumSha256}`,
  ].join("\n");
}
