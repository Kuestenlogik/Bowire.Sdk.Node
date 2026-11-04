// Start the real Bowire workbench headless and talk to its HTTP API.
//
// `bowire discover` proves a plugin installs and answers, but the CLI has no
// workspace, so it never sends plugin settings, and it has no command that
// drives a duplex channel. The workbench does both, behind the same REST
// endpoints its UI calls — so this is the host an operator uses, not a
// stand-in for it.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";

export interface Workbench {
  url: string;
  logFile: string;
  stop(): Promise<void>;
}

// Launch `bowire` on an OS-picked port and resolve once it is listening.
//
// The handshake is the port file: the host writes it only after a successful
// bind (`--port-file`), so its appearance is the ready signal. Watched, not
// polled; an early exit of the host rejects instead of waiting forever.
// The host's own log goes to host.log in `workDir` (request logging makes it
// long); `logFile` names it so a failing run can print it.
export async function startWorkbench(
  bowire: string,
  pluginDir: string,
  workDir: string,
): Promise<Workbench> {
  const portFile = join(workDir, "port.json");
  const logFile = join(workDir, "host.log");
  // A host that was killed rather than stopped leaves its port file behind,
  // and a stale one would read as "ready" at a port nobody listens on.
  rmSync(portFile, { force: true });
  const log = openSync(logFile, "w");
  const child = spawn(
    bowire,
    ["--plugin-dir", pluginDir, "--no-browser", "--port", "0", "--port-file", portFile],
    { stdio: ["ignore", log, log] },
  );
  // The child holds its own handle now.
  closeSync(log);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const url = await new Promise<string>((resolve, reject) => {
    const watcher = watch(workDir);
    const finish = (error: Error | null, value?: string) => {
      watcher.close();
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value as string);
    };
    const tryRead = () => {
      if (!existsSync(portFile)) return;
      try {
        const parsed = JSON.parse(readFileSync(portFile, "utf8")) as { url?: string };
        if (parsed.url) finish(null, parsed.url.replace(/\/$/, ""));
      } catch {
        // Seen mid-write; the write that completes it raises another event.
      }
    };
    const onExit = (code: number | null) =>
      finish(new Error(`bowire exited (${code}) before it was listening; see ${logFile}`));
    const onError = (e: Error) => finish(e);
    child.once("exit", onExit);
    child.once("error", onError);
    watcher.on("change", tryRead);
    // The watcher is armed first, so a file written before this line is
    // still seen here and one written after raises an event.
    tryRead();
  });

  return { url, logFile, stop: () => stopChild(child, exited) };
}

async function stopChild(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return readJson<T>(res, "GET", url);
}

export async function sendJson<T>(method: "POST" | "PUT", url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<T>(res, method, url);
}

async function readJson<T>(res: Response, method: string, url: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export interface SseEvent {
  event: string;
  data: string;
}

// Read a Server-Sent-Events response until the server ends it, handing each
// event to `onEvent` as it arrives.
export async function readSse(
  res: Response,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`SSE ${res.url} -> ${res.status}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) onEvent({ event, data: data.join("\n") });
    }
  }
}
