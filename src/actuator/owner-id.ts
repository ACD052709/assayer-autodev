import { OWNER_ID_PATTERN, type GitHubOwnerIdentity } from "./types.js";
import { ActuatorError } from "./errors.js";

/**
 * Control-plane ownerId allows only `[a-zA-Z0-9._-]`.
 * GitHub `owner/repo:run:attempt` is therefore mapped to:
 * `github-actions.<owner>.<repo>.<runId>.<runAttempt>`
 */
export function githubActionsOwnerId(identity: GitHubOwnerIdentity): string {
  const repository = sanitizeSegment(identity.repository, "repository").replaceAll("/", ".");
  const runId = sanitizeSegment(identity.runId, "runId");
  const runAttempt = sanitizeSegment(identity.runAttempt, "runAttempt");
  const ownerId = `github-actions.${repository}.${runId}.${runAttempt}`;
  if (!OWNER_ID_PATTERN.test(ownerId)) {
    throw new ActuatorError("invalid_config", "Generated ownerId is not a valid control-plane entity ID");
  }
  return ownerId;
}

function sanitizeSegment(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ActuatorError("invalid_config", `Missing GitHub ${field} for ownerId`);
  }
  const mapped = trimmed.replace(/[^a-zA-Z0-9._/-]/g, "-");
  if (mapped.replaceAll("/", "").length === 0) {
    throw new ActuatorError("invalid_config", `Invalid GitHub ${field} for ownerId`);
  }
  return mapped;
}
