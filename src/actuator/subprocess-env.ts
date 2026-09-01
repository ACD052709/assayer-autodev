/**
 * Removes credentials/control-plane secrets before running repository-controlled code.
 * The worker process itself may hold secrets, but candidate tests/build scripts must not inherit them.
 */
const SECRET_NAME_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)(?:$|_)/i;

const EXPLICIT_SECRET_KEYS = new Set([
  "AUTODEV_SERVICE_TOKEN",
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
]);

export function sanitizedCandidateEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (EXPLICIT_SECRET_KEYS.has(key) || SECRET_NAME_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}
