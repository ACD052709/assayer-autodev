import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeCandidate } from "../domain/code-candidate.js";
import { verifyPatchChecksum } from "../security/checksum.js";
import { sanitizedCandidateEnv } from "../actuator/subprocess-env.js";
import { BrowserVerifierError } from "./errors.js";

export interface CandidateRuntimeConfig {
  readonly setupCommands: readonly (readonly string[])[];
  readonly serverCommand: readonly string[];
  readonly port: number;
  readonly targetRepositoryToken?: string;
  readonly setupTimeoutMs?: number;
  readonly serverReadyTimeoutMs?: number;
}

export interface CandidateRuntime {
  readonly workDir: string;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

function validateArgv(argv: readonly string[], field: string): readonly string[] {
  if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new BrowserVerifierError("invalid_config", `${field} must contain non-empty argv strings`);
  }
  return argv;
}

export function parseCandidateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CandidateRuntimeConfig {
  let setupCommands: unknown = [];
  let serverCommand: unknown;
  try {
    setupCommands = JSON.parse(env.AUTODEV_BROWSER_SETUP_COMMANDS_JSON?.trim() || "[]");
  } catch {
    throw new BrowserVerifierError("invalid_config", "AUTODEV_BROWSER_SETUP_COMMANDS_JSON must be valid JSON");
  }
  try {
    serverCommand = JSON.parse(env.AUTODEV_BROWSER_SERVER_COMMAND_JSON?.trim() || "null");
  } catch {
    throw new BrowserVerifierError("invalid_config", "AUTODEV_BROWSER_SERVER_COMMAND_JSON must be valid JSON");
  }
  if (!Array.isArray(setupCommands) || !setupCommands.every((cmd) => Array.isArray(cmd))) {
    throw new BrowserVerifierError("invalid_config", "AUTODEV_BROWSER_SETUP_COMMANDS_JSON must be an array of argv arrays");
  }
  if (!Array.isArray(serverCommand)) {
    throw new BrowserVerifierError("invalid_config", "AUTODEV_BROWSER_SERVER_COMMAND_JSON must be an argv array");
  }
  const port = Number(env.AUTODEV_BROWSER_SERVER_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new BrowserVerifierError("invalid_config", "AUTODEV_BROWSER_SERVER_PORT must be an integer from 1024 to 65535");
  }
  return {
    setupCommands: setupCommands.map((cmd, index) => validateArgv(cmd as string[], `setupCommands[${index}]`)),
    serverCommand: validateArgv(serverCommand as string[], "serverCommand"),
    port,
    ...(env.AUTODEV_TARGET_REPO_TOKEN?.trim()
      ? { targetRepositoryToken: env.AUTODEV_TARGET_REPO_TOKEN.trim() }
      : {}),
  };
}

function redacted(value: string, secret?: string): string {
  if (!secret) return value;
  return value.split(secret).join("[REDACTED]");
}

function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env = sanitizedCandidateEnv();
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

async function runCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, [...argv.slice(1)], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { if (stdout.length < 64_000) stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 64_000) stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function requireCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  label: string,
  secret?: string,
): Promise<void> {
  const result = await runCommand(argv, cwd, timeoutMs, env);
  if (result.exitCode !== 0) {
    const detail = redacted(result.stderr || result.stdout, secret).trim().slice(0, 1000);
    throw new BrowserVerifierError("execution_failed", `${label} failed${detail ? `: ${detail}` : ""}`);
  }
}

async function waitForReady(baseUrl: string, child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new BrowserVerifierError("execution_failed", `Candidate server exited before becoming ready (${child.exitCode})`);
    }
    try {
      const response = await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(1500) });
      if (response.status >= 100 && response.status < 600) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new BrowserVerifierError("execution_failed", "Candidate server did not become ready before timeout");
}

export async function startExactCandidateRuntime(input: {
  readonly candidate: CodeCandidate;
  readonly patchContent: string;
  readonly config: CandidateRuntimeConfig;
}): Promise<CandidateRuntime> {
  if (!verifyPatchChecksum(input.patchContent, input.candidate.patchChecksumSha256)) {
    throw new BrowserVerifierError("invalid_spec", "Candidate patch checksum mismatch");
  }

  const root = await mkdtemp(join(tmpdir(), "assayer-autodev-verify-"));
  const workDir = join(root, "candidate");
  const patchFile = join(root, "candidate.patch");
  const authEnv = gitEnv(input.config.targetRepositoryToken);
  const candidateEnv = sanitizedCandidateEnv();
  let server: ReturnType<typeof spawn> | undefined;

  try {
    await requireCommand(
      ["git", "clone", "--no-checkout", `https://github.com/${input.candidate.sourceRepository}.git`, workDir],
      root,
      180_000,
      authEnv,
      "Candidate clone",
      input.config.targetRepositoryToken,
    );
    await requireCommand(
      ["git", "fetch", "--depth", "1", "origin", input.candidate.baseCommitSha],
      workDir,
      120_000,
      authEnv,
      "Candidate base fetch",
      input.config.targetRepositoryToken,
    );
    await requireCommand(
      ["git", "checkout", "--detach", input.candidate.baseCommitSha],
      workDir,
      120_000,
      authEnv,
      "Candidate base checkout",
      input.config.targetRepositoryToken,
    );
    await writeFile(patchFile, input.patchContent, "utf8");
    await requireCommand(["git", "apply", "--check", patchFile], workDir, 60_000, authEnv, "Candidate patch check");
    await requireCommand(["git", "apply", "--whitespace=nowarn", patchFile], workDir, 60_000, authEnv, "Candidate patch apply");

    for (const command of input.config.setupCommands) {
      await requireCommand(
        command,
        workDir,
        input.config.setupTimeoutMs ?? 300_000,
        candidateEnv,
        `Candidate setup command ${command[0]}`,
      );
    }

    server = spawn(input.config.serverCommand[0]!, [...input.config.serverCommand.slice(1)], {
      cwd: workDir,
      env: candidateEnv,
      // Candidate output is intentionally discarded. Unconsumed pipe buffers can
      // otherwise backpressure a noisy dev server and make verification hang.
      stdio: ["ignore", "ignore", "ignore"],
    });
    const baseUrl = `http://127.0.0.1:${input.config.port}/`;
    await waitForReady(baseUrl, server, input.config.serverReadyTimeoutMs ?? 45_000);

    return {
      workDir,
      baseUrl,
      async stop() {
        if (server && server.exitCode === null) {
          server.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (server && server.exitCode === null) server.kill("SIGKILL");
              resolve();
            }, 5000);
            server?.once("close", () => { clearTimeout(timer); resolve(); });
          });
        }
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server && server.exitCode === null) server.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
