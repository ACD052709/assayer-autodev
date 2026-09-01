import { describe, expect, it } from "vitest";
import { sanitizedCandidateEnv } from "../src/actuator/subprocess-env.js";

describe("sanitizedCandidateEnv", () => {
  it("preserves ordinary execution variables but strips credentials", () => {
    const env = sanitizedCandidateEnv({
      PATH: "/bin",
      HOME: "/tmp/home",
      CI: "true",
      AUTODEV_SERVICE_TOKEN: "service-secret",
      CURSOR_API_KEY: "cursor-secret",
      OPENAI_API_KEY: "openai-secret",
      GITHUB_TOKEN: "github-secret",
      SOME_PASSWORD: "password",
      VENDOR_AUTH_TOKEN: "auth-secret",
      SAFE_SETTING: "ok",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/tmp/home");
    expect(env.CI).toBe("true");
    expect(env.SAFE_SETTING).toBe("ok");
    expect(env.AUTODEV_SERVICE_TOKEN).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
    expect(env.VENDOR_AUTH_TOKEN).toBeUndefined();
  });
});
