import { access } from "node:fs/promises";
import { join } from "node:path";

export interface TargetSetupCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly reason: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic dependency bootstrap selected only from committed lockfiles.
 * It runs outside the model-controlled shell with a sanitized environment.
 * Repositories without a recognized lockfile are left untouched.
 */
export async function detectTargetSetupCommand(cwd: string): Promise<TargetSetupCommand | undefined> {
  if (await exists(join(cwd, "package-lock.json")) || await exists(join(cwd, "npm-shrinkwrap.json"))) {
    return {
      command: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
      reason: "npm lockfile",
    };
  }
  if (await exists(join(cwd, "pnpm-lock.yaml"))) {
    return {
      command: "corepack",
      args: ["pnpm", "install", "--frozen-lockfile"],
      reason: "pnpm lockfile",
    };
  }
  if (await exists(join(cwd, "yarn.lock"))) {
    return {
      command: "corepack",
      args: ["yarn", "install", "--immutable"],
      reason: "yarn lockfile",
    };
  }
  return undefined;
}
