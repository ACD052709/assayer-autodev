import { readFile } from "node:fs/promises";
import { parseBrowserTestSpec } from "../verifier/browser-spec.js";
import { runBrowserSuite } from "../verifier/browser-runner.js";
import { createPlaywrightAutomation } from "../verifier/playwright-automation.js";
import { BrowserVerifierError } from "../verifier/errors.js";

interface CliOptions {
  readonly specPath: string;
  readonly targetUrl?: string;
  readonly screenshotDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let specPath: string | undefined;
  let targetUrl: string | undefined;
  let screenshotDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--spec") {
      specPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--target-url") {
      targetUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--screenshot-dir") {
      screenshotDir = argv[i + 1];
      i += 1;
    }
  }
  if (specPath === undefined || specPath.trim().length === 0) {
    throw new BrowserVerifierError("invalid_config", "Missing required --spec <path>");
  }
  return {
    specPath,
    ...(targetUrl !== undefined ? { targetUrl } : {}),
    ...(screenshotDir !== undefined ? { screenshotDir } : {}),
  };
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const raw = JSON.parse(await readFile(options.specPath, "utf8")) as unknown;
  const spec = parseBrowserTestSpec(raw, options.targetUrl);
  const automation = await createPlaywrightAutomation();
  const result = await runBrowserSuite({
    spec,
    automation,
    ...(options.screenshotDir !== undefined ? { screenshotDir: options.screenshotDir } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.outcome === "PASS" ? 0 : 1;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
