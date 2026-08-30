import type { MasterModelCallResult, MasterModelClient, MasterModelRequest } from "./client.js";
import { MasterModelConfigError, toSafeModelError } from "./errors.js";
import { MASTER_OUTPUT_JSON_SCHEMA, MASTER_OUTPUT_SCHEMA_NAME } from "./schema.js";

export const MASTER_MODEL_ID = "gpt-5.6-sol";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface OpenAIMasterModelClientOptions {
  readonly apiKey: string | undefined;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface ResponsesBody {
  readonly output_text?: string;
  readonly usage?: ResponsesUsage;
  readonly output?: readonly {
    readonly type?: string;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  }[];
}

function extractOutputText(body: ResponsesBody): string | undefined {
  if (typeof body.output_text === "string" && body.output_text.trim().length > 0) {
    return body.output_text;
  }
  if (!Array.isArray(body.output)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of body.output) {
    if (!item.content) {
      continue;
    }
    for (const content of item.content) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("");
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null, now: () => number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 8_000);
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(dateMs - now(), 0), 8_000);
    }
  }
  return Math.min(250 * 2 ** attempt, 4_000);
}

export class OpenAIMasterModelClient implements MasterModelClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenAIMasterModelClientOptions) {
    const key = options.apiKey?.trim();
    if (key === undefined || key.length === 0) {
      throw new MasterModelConfigError();
    }
    this.apiKey = key;
    this.model = options.model ?? MASTER_MODEL_ID;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async complete(request: MasterModelRequest): Promise<MasterModelCallResult> {
    const body = JSON.stringify({
      model: this.model,
      input: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: JSON.stringify(request.userPayload) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: MASTER_OUTPUT_SCHEMA_NAME,
          strict: true,
          schema: MASTER_OUTPUT_JSON_SCHEMA,
        },
      },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const response = await fetchWithTimeout(
          this.fetchImpl,
          OPENAI_RESPONSES_URL,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
            },
            body,
          },
          this.timeoutMs,
        );

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxAttempts - 1) {
          await this.sleep(retryDelayMs(attempt, response.headers.get("retry-after"), this.now));
          continue;
        }

        if (!response.ok) {
          throw toSafeModelError(new Error(`OpenAI request failed with status ${response.status}`));
        }

        const parsed = (await response.json()) as ResponsesBody;
        const text = extractOutputText(parsed);
        if (text === undefined) {
          throw toSafeModelError(new Error("OpenAI response missing structured output"));
        }

        let output: unknown;
        try {
          output = JSON.parse(text) as unknown;
        } catch {
          throw toSafeModelError(new Error("OpenAI response was not valid JSON"));
        }

        const inputTokens = parsed.usage?.input_tokens;
        const outputTokens = parsed.usage?.output_tokens;
        return {
          output,
          model: this.model,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        };
      } catch (error) {
        lastError = error;
        const retryableNetwork =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError");
        if (retryableNetwork && attempt < this.maxAttempts - 1) {
          await this.sleep(retryDelayMs(attempt, null, this.now));
          continue;
        }
        throw toSafeModelError(error);
      }
    }

    throw toSafeModelError(lastError);
  }
}
