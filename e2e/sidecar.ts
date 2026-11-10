// The example as an http sidecar: a process of its own that the host connects
// to, rather than one it spawns.
//
// The host does not own such a sidecar, so the e2e starts it, on a port the
// OS picks, and stops it at the end. The ready signal is the line the example
// prints once it listens; that line also carries the port. It is read off the
// process's own output as it arrives, which is also copied to a log file for
// a failing run to print. (Watching the log file instead does not work: on
// Windows a watch does not report another process appending to a file it
// holds open.)

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";

export interface HttpSidecar {
  url: string;
  logFile: string;
  // Stops the sidecar and resolves with how it exited.
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const READY = /listening on (http:\/\/\S+)/;

export async function startHttpSidecar(entry: string, workDir: string): Promise<HttpSidecar> {
  const logFile = join(workDir, "sidecar.log");
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, [entry], {
    // The example's own switch for HTTP mode; 0 lets the OS pick the port.
    env: { ...process.env, BOWIRE_HTTP_PORT: "0" },
    cwd: dirname(entry),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => {
      log.end();
      resolve({ code, signal });
    }),
  );

  const url = await new Promise<string>((resolve, reject) => {
    let seen = "";
    const finish = (error: Error | null, value?: string) => {
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value as string);
    };
    const onData = (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      const match = READY.exec(seen);
      if (match) finish(null, match[1] as string);
    };
    const onExit = (code: number | null) =>
      finish(new Error(`the sidecar exited (${code}) before it was listening; see ${logFile}`));
    const onError = (e: Error) => finish(e);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });

  return { url, logFile, stop: () => stopChild(child, exited) };
}

async function stopChild(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  return exited;
}
