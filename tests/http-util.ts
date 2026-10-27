import type { App } from "../src/http/server.js";

export async function withServer(app: App, fn: (base: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a tcp port");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    for (const client of app.wss.clients) client.terminate();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      app.wss.close(() => resolve());
    });
    if (app.server.listening) {
      await new Promise<void>((resolve) => {
        app.server.close(() => resolve());
      });
    }
  }
}

export function formBody(params: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, value);
  return body.toString();
}

export async function postForm(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: formBody(params),
  });
  return { status: response.status, text: await response.text() };
}
