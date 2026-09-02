import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectTargetSetupCommand } from "../src/actuator/target-setup.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "autodev-target-setup-"));
}

describe("target dependency setup", () => {
  it("uses npm ci only when an npm lockfile exists", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package-lock.json"), "{}", "utf8");
    expect(await detectTargetSetupCommand(cwd)).toEqual({
      command: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
      reason: "npm lockfile",
    });
  });

  it("supports deterministic pnpm and yarn lockfiles", async () => {
    const pnpm = await tempDir();
    await writeFile(join(pnpm, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");
    expect(await detectTargetSetupCommand(pnpm)).toMatchObject({
      command: "corepack",
      args: ["pnpm", "install", "--frozen-lockfile"],
    });

    const yarn = await tempDir();
    await writeFile(join(yarn, "yarn.lock"), "# lock", "utf8");
    expect(await detectTargetSetupCommand(yarn)).toMatchObject({
      command: "corepack",
      args: ["yarn", "install", "--immutable"],
    });
  });

  it("does not perform an unpinned dependency install without a lockfile", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), "{}", "utf8");
    expect(await detectTargetSetupCommand(cwd)).toBeUndefined();
  });
});
