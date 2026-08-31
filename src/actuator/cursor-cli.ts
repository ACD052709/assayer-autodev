import { join } from "node:path";

export const CURSOR_CLI_COMMAND = "cursor-agent";

export interface CursorCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly requiredEnvKeys: readonly string[];
}

export interface BuildCursorCliInvocationInput {
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly model?: string;
}

/**
 * Official Cursor CLI headless invocation (non-interactive print mode).
 * CURSOR_API_KEY must be present in the process environment at execution time.
 */
export function buildCursorCliInvocation(input: BuildCursorCliInvocationInput): CursorCliInvocation {
  const model = input.model?.trim() || "auto";
  return {
    command: CURSOR_CLI_COMMAND,
    args: [
      "--print",
      "--output-format",
      "text",
      "--force",
      "--model",
      model,
      "--workspace",
      input.workspaceDir,
      input.prompt,
    ],
    cwd: input.workspaceDir,
    timeoutMs: input.timeoutMs,
    requiredEnvKeys: ["CURSOR_API_KEY"],
  };
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
