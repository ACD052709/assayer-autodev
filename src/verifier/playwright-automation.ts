import type { BrowserAutomation, BrowserNetworkFailure, BrowserPageSession } from "./types.js";

interface PlaywrightModule {
  chromium: {
    launch(): Promise<{
      newPage(): Promise<PlaywrightPage>;
      close(): Promise<void>;
    }>;
  };
}

interface PlaywrightPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" }): Promise<unknown>;
  url(): string;
  screenshot(options: { path: string }): Promise<Buffer>;
  close(): Promise<void>;
  waitForLoadState(state: "load" | "domcontentloaded", options?: { timeout?: number }): Promise<void>;
  on(event: "console", handler: (message: { type(): string; text(): string }) => void): void;
  on(
    event: "requestfailed",
    handler: (request: { url(): string; method(): string; failure(): { errorText: string } | null }) => void,
  ): void;
  on(event: "response", handler: (response: { url(): string; status(): number; request(): { method(): string } }) => void): void;
  locator(selector: string): PlaywrightLocator;
  getByText(text: string, options?: { exact?: boolean }): PlaywrightLocator;
}

interface PlaywrightLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "visible" | "hidden" | "attached"; timeout?: number }): Promise<void>;
  isChecked(options?: { timeout?: number }): Promise<boolean>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
}

class PlaywrightPageSession implements BrowserPageSession {
  readonly consoleErrors: string[] = [];
  readonly failedNetworkRequests: BrowserNetworkFailure[] = [];

  constructor(private readonly page: PlaywrightPage) {
    page.on("console", (message) => {
      if (message.type() === "error") {
        this.consoleErrors.push(message.text());
      }
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 400) {
        this.failedNetworkRequests.push({
          url: response.url(),
          status,
          method: response.request().method(),
        });
      }
    });
    page.on("requestfailed", (request) => {
      this.failedNetworkRequests.push({
        url: request.url(),
        method: request.method(),
      });
    });
  }

  get finalUrl(): string {
    return this.page.url();
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  }

  async assertPageLoad(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState("load", { timeout: timeoutMs });
  }

  private resolveLocator(input: { selector?: string; text?: string; exact?: boolean }): PlaywrightLocator {
    if (input.selector !== undefined) {
      return this.page.locator(input.selector);
    }
    if (input.text !== undefined) {
      return this.page.getByText(input.text, { exact: input.exact ?? false });
    }
    throw new Error("selector or text is required");
  }

  async find(input: { selector?: string; text?: string; exact?: boolean }, timeoutMs: number): Promise<void> {
    await this.resolveLocator(input).waitFor({ state: "visible", timeout: timeoutMs });
  }

  async click(input: { selector?: string; text?: string; exact?: boolean }, timeoutMs: number): Promise<void> {
    await this.resolveLocator(input).click({ timeout: timeoutMs });
  }

  async fill(selector: string, value: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).fill(value, { timeout: timeoutMs });
  }

  async assertVisibleText(text: string, exact: boolean, timeoutMs: number): Promise<void> {
    await this.page.getByText(text, { exact }).waitFor({ state: "visible", timeout: timeoutMs });
  }

  async assertElementVisible(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).waitFor({ state: "visible", timeout: timeoutMs });
  }

  async assertElementHidden(selector: string, timeoutMs: number): Promise<void> {
    await this.page.locator(selector).waitFor({ state: "hidden", timeout: timeoutMs });
  }

  async assertChecked(selector: string, checked: boolean, timeoutMs: number): Promise<void> {
    const actual = await this.page.locator(selector).isChecked({ timeout: timeoutMs });
    if (actual !== checked) {
      throw new Error(`Expected checked=${String(checked)} but got ${String(actual)} for ${selector}`);
    }
  }

  async assertEnabled(selector: string, enabled: boolean, timeoutMs: number): Promise<void> {
    const actual = await this.page.locator(selector).isEnabled({ timeout: timeoutMs });
    if (actual !== enabled) {
      throw new Error(`Expected enabled=${String(enabled)} but got ${String(actual)} for ${selector}`);
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path });
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

export class PlaywrightBrowserAutomation implements BrowserAutomation {
  private browser: { newPage(): Promise<PlaywrightPage>; close(): Promise<void> } | undefined;

  constructor(private readonly playwright: PlaywrightModule) {}

  async open(_baseUrl: string): Promise<BrowserPageSession> {
    if (this.browser === undefined) {
      this.browser = await this.playwright.chromium.launch();
    }
    const page = await this.browser.newPage();
    return new PlaywrightPageSession(page);
  }

  async close(): Promise<void> {
    if (this.browser !== undefined) {
      await this.browser.close();
      this.browser = undefined;
    }
  }
}

export async function createPlaywrightAutomation(): Promise<BrowserAutomation> {
  const playwright = (await import("playwright")) as PlaywrightModule;
  return new PlaywrightBrowserAutomation(playwright);
}
