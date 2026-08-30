import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../src/api/index.js";
import {
  assertCallerPermitted,
  assertKnownRole,
  logServerError,
  policyFor,
  SERVICE_TOKEN_CALLER,
} from "../src/api/auth/index.js";
import { ApiError } from "../src/api/errors.js";
import { MAX_BOOTSTRAP_BLOB_BYTES, MAX_JSON_BODY_BYTES } from "../src/api/security/index.js";
import { InMemoryEvidenceBlobStore } from "../src/evidence/index.js";
import { asAsyncStore, createInMemoryStateStore } from "../src/state/index.js";

const TEST_TOKEN = "test-service-token";
const BASE = "http://localhost";

function createRouter(options?: {
  serviceToken?: string | undefined;
  production?: boolean;
  store?: ReturnType<typeof asAsyncStore>;
  blobs?: InMemoryEvidenceBlobStore;
}) {
  const syncStore = createInMemoryStateStore();
  const store = options?.store ?? asAsyncStore(syncStore);
  const blobs = options?.blobs ?? new InMemoryEvidenceBlobStore();
  return createApiRouter({
    deps: { store, blobs },
    auth: {
      serviceToken:
        options !== undefined && "serviceToken" in options
          ? options.serviceToken
          : TEST_TOKEN,
      production: options?.production ?? false,
    },
  });
}

async function apiRequest(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  path: string,
  init?: {
    body?: unknown;
    token?: string | null;
    contentType?: string;
    contentLength?: string;
    rawBody?: string;
  },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init?.token !== null) {
    headers.authorization = `Bearer ${init?.token ?? TEST_TOKEN}`;
  }
  if (init?.contentType !== undefined) {
    headers["content-type"] = init.contentType;
  } else if (init?.body !== undefined || init?.rawBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init?.contentLength !== undefined) {
    headers["content-length"] = init.contentLength;
  }

  const body =
    init?.rawBody !== undefined
      ? init.rawBody
      : init?.body !== undefined
        ? JSON.stringify(init.body)
        : undefined;

  const requestInit: RequestInit = { method, headers };
  if (body !== undefined) {
    requestInit.body = body;
  }

  return router(new Request(`${BASE}${path}`, requestInit));
}

describe("API security", () => {
  let router: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    router = createRouter();
  });

  it("allows unauthenticated GET /health", async () => {
    const res = await apiRequest(router, "GET", "/health", { token: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok" });
    expect(JSON.stringify(body)).not.toMatch(/AUTODEV|bucket|database|ENVIRONMENT/i);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects protected GET without token", async () => {
    await apiRequest(router, "POST", "/api/projects", {
      body: { id: "proj-sec", name: "S", description: "S" },
    });
    const res = await apiRequest(router, "GET", "/api/projects/proj-sec/state", { token: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects protected POST without token", async () => {
    const res = await apiRequest(router, "POST", "/api/projects", {
      token: null,
      body: { id: "proj-noauth", name: "N", description: "N" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong token", async () => {
    const res = await apiRequest(router, "POST", "/api/projects", {
      token: "wrong-token",
      body: { id: "proj-badtok", name: "B", description: "B" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct bearer token", async () => {
    const res = await apiRequest(router, "POST", "/api/projects", {
      body: { id: "proj-good", name: "G", description: "G" },
    });
    expect(res.status).toBe(201);
  });

  it("rejects malformed Authorization header", async () => {
    const res = await router(
      new Request(`${BASE}/api/projects`, {
        method: "POST",
        headers: {
          authorization: "Token not-bearer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "proj-mal", name: "M", description: "M" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 415 for non-JSON POST", async () => {
    const res = await apiRequest(router, "POST", "/api/projects", {
      contentType: "text/plain",
      rawBody: "not json",
    });
    expect(res.status).toBe(415);
  });

  it("returns 413 for oversized Content-Length", async () => {
    const res = await apiRequest(router, "POST", "/api/projects", {
      contentType: "application/json",
      contentLength: String(MAX_JSON_BODY_BYTES + 1),
      rawBody: "{}",
    });
    expect(res.status).toBe(413);
  });

  it("returns 413 for oversized JSON body", async () => {
    const huge = "x".repeat(MAX_JSON_BODY_BYTES + 1);
    const res = await apiRequest(router, "POST", "/api/projects", {
      rawBody: JSON.stringify({ id: "proj-big", name: huge, description: "d" }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects malformed base64 evidence blob", async () => {
    await apiRequest(router, "POST", "/api/projects", {
      body: { id: "proj-ev", name: "E", description: "E" },
    });
    await apiRequest(router, "POST", "/api/tasks", {
      body: {
        id: "task-ev",
        projectId: "proj-ev",
        title: "T",
        description: "D",
        kind: "verification",
      },
    });

    const res = await apiRequest(router, "POST", "/api/evidence", {
      body: {
        id: "ev-bad64",
        projectId: "proj-ev",
        taskId: "task-ev",
        kind: "log",
        label: "bad",
        blobBase64: "!!!not-base64!!!",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects decoded evidence blob over 64 KiB", async () => {
    await apiRequest(router, "POST", "/api/projects", {
      body: { id: "proj-bigblob", name: "B", description: "B" },
    });
    await apiRequest(router, "POST", "/api/tasks", {
      body: {
        id: "task-bigblob",
        projectId: "proj-bigblob",
        title: "T",
        description: "D",
        kind: "verification",
      },
    });

    const oversized = Buffer.alloc(MAX_BOOTSTRAP_BLOB_BYTES + 1, 1).toString("base64");
    const res = await apiRequest(router, "POST", "/api/evidence", {
      body: {
        id: "ev-big",
        projectId: "proj-bigblob",
        taskId: "task-bigblob",
        kind: "artifact",
        label: "big",
        blobBase64: oversized,
      },
    });
    expect(res.status).toBe(413);
  });

  it("cleans up blob when metadata persistence fails", async () => {
    const blobs = new InMemoryEvidenceBlobStore();
    const syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    store.createEvidence = async () => {
      throw new Error("simulated metadata failure");
    };
    const secured = createRouter({ store, blobs });

    await apiRequest(secured, "POST", "/api/projects", {
      body: { id: "proj-cleanup", name: "C", description: "C" },
    });
    await apiRequest(secured, "POST", "/api/tasks", {
      body: {
        id: "task-cleanup",
        projectId: "proj-cleanup",
        title: "T",
        description: "D",
        kind: "verification",
      },
    });

    const key = "proj-cleanup/evidence/ev-cleanup";
    const res = await apiRequest(secured, "POST", "/api/evidence", {
      body: {
        id: "ev-cleanup",
        projectId: "proj-cleanup",
        taskId: "task-cleanup",
        kind: "log",
        label: "cleanup",
        blobBase64: Buffer.from("hello").toString("base64"),
      },
    });
    expect(res.status).toBe(500);
    expect(await blobs.exists(key)).toBe(false);
  });

  it("rejects unknown roles in policy helpers", () => {
    expect(() => assertKnownRole("intruder")).toThrow(ApiError);
    expect(() =>
      assertCallerPermitted({ role: "master" }, policyFor(["admin"])),
    ).toThrow(ApiError);
    expect(() =>
      assertCallerPermitted(SERVICE_TOKEN_CALLER, policyFor(["admin"])),
    ).not.toThrow();
  });

  it("fails closed when AUTODEV_SERVICE_TOKEN is missing", async () => {
    const unconfigured = createRouter({ serviceToken: undefined });
    const res = await apiRequest(unconfigured, "POST", "/api/projects", {
      body: { id: "proj-unconfigured", name: "U", description: "U" },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_misconfigured");
  });

  it("does not leak stack traces or internal errors to clients", async () => {
    const syncStore = createInMemoryStateStore();
    const store = asAsyncStore(syncStore);
    store.createProject = async () => {
      throw new Error("SECRET_SQL_DETAIL at Object.handle");
    };
    const production = createRouter({ store, production: true });

    const res = await apiRequest(production, "POST", "/api/projects", {
      body: { id: "proj-err", name: "E", description: "E" },
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SECRET_SQL_DETAIL");
    expect(text).not.toContain("Object.handle");
    expect(text).toContain("internal_error");
  });

  it("logs server errors without authorization headers", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerError("test", new Error("backend failure"));
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toMatch(/Bearer/i);
    errorSpy.mockRestore();
  });
});
