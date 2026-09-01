import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface BrowserVerifierFixture {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export async function startBrowserVerifierFixture(): Promise<BrowserVerifierFixture> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (path === "/slow") {
      setTimeout(() => {
        sendHtml(res, "<html><body><h1>Slow</h1></body></html>");
      }, 2_000);
      return;
    }
    if (path === "/form") {
      sendHtml(
        res,
        `<html><body>
          <h1>Form page</h1>
          <input id="name" type="text" />
          <button id="submit">Submit</button>
          <p id="result" hidden>Submitted</p>
        </body></html>`,
      );
      return;
    }
    sendHtml(
      res,
      `<html><body>
        <h1>Fixture home</h1>
        <button id="go-form">Open form</button>
        <a href="/form">Form link</a>
      </body></html>`,
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind browser verifier fixture");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
