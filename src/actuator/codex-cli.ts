import { join } from "node:path";
import type { CodingModelId } from "../domain/coding-model.js";
import { DEFAULT_CODING_MODEL } from "../domain/coding-model.js";

export const CODEX_CLI_COMMAND = "codex";

export interface CodexCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly requiredEnvKeys: readonly string[];
  readonly model: CodingModelId;
}

export interface BuildCodexCliInvocationInput {
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly model?: CodingModelId;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export function reasoningEffortForCodingModel(
  model: CodingModelId,
): "low" | "medium" | "high" {
  if (model === "gpt-5.6-sol") return "high";
  if (model === "gpt-5.6-terra") return "medium";
  return "low";
}

/**
 * Non-interactive Codex invocation for the isolated coding checkout.
 *
 * Security boundaries:
 * - workspace-write only (no full-access sandbox)
 * - network disabled inside the model-controlled shell
 * - approval prompts disabled so unattended CI fails within the sandbox instead of escalating
 * - standard service tier pinned so pricing cannot silently inherit Fast/Priority routing
 * - code-mode host and multi-agent runtimes disabled to avoid hidden tool/subagent multiplication
 * - default secret-name exclusions enabled for model-controlled subprocesses
 * - user config and exec-policy rules ignored for deterministic CI behavior
 * - ephemeral session data
 *
 * CODEX_API_KEY is injected only into the Codex process by coding-task.ts.
 */
export function buildCodexCliInvocation(input: BuildCodexCliInvocationInput): CodexCliInvocation {
  const model = input.model ?? DEFAULT_CODING_MODEL;
  const reasoningEffort = input.reasoningEffort ?? reasoningEffortForCodingModel(model);
  return {
    command: CODEX_CLI_COMMAND,
    args: [
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--json",
      "-c",
      "default_permissions=\":workspace\"",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "code_mode",
      "--disable",
      "code_mode_host",
      "--disable",
      "multi_agent",
      "--disable",
      "multi_agent_v2",
      "--disable",
      "fast_mode",
      "--model",
      model,
      "-c",
      `model_reasoning_effort=\"${reasoningEffort}\"`,
      "-c",
      'service_tier="default"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "shell_environment_policy.ignore_default_excludes=false",
      "-c",
      "shell_environment_policy.inherit=\"core\"",
      input.prompt,
    ],
    cwd: input.workspaceDir,
    timeoutMs: input.timeoutMs,
    requiredEnvKeys: ["CODEX_API_KEY"],
    model,
  };
}

export interface CodexUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export function parseCodexUsage(jsonl: string): CodexUsage | undefined {
  let latest: CodexUsage | undefined;
  for (const raw of jsonl.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== "turn.completed") continue;
    const usage = event.usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) continue;
    const u = usage as Record<string, unknown>;
    const inputTokens = finiteNonNegative(u.input_tokens);
    const cachedInputTokens = finiteNonNegative(u.cached_input_tokens);
    // Codex 0.148 emits cache_write_input_tokens. Accept cache_write_tokens too
    // so a future CLI schema rename does not silently lose billed cache writes.
    const cacheWriteInputTokens =
      finiteNonNegative(u.cache_write_input_tokens) ?? finiteNonNegative(u.cache_write_tokens);
    const outputTokens = finiteNonNegative(u.output_tokens);
    const reasoningOutputTokens = finiteNonNegative(u.reasoning_output_tokens);
    if (inputTokens === undefined || outputTokens === undefined) continue;
    latest = {
      inputTokens,
      cachedInputTokens: Math.min(cachedInputTokens ?? 0, inputTokens),
      cacheWriteInputTokens: Math.min(
        cacheWriteInputTokens ?? 0,
        Math.max(0, inputTokens - Math.min(cachedInputTokens ?? 0, inputTokens)),
      ),
      outputTokens,
      reasoningOutputTokens: reasoningOutputTokens ?? 0,
    };
  }
  return latest;
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function isolatedCheckoutDirectory(workspaceRoot: string, workerRunId: string): string {
  return join(workspaceRoot, workerRunId, "target");
}

export function parseTrustedTestCommand(command: string): { readonly command: string; readonly args: readonly string[] } {
  const parts = command.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error("Trusted test command is empty");
  }
  return { command: parts[0]!, args: parts.slice(1) };
}
