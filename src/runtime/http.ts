import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BowirePlugin } from "../plugin.js";
import { dispatch } from "./dispatch.js";
import type { Request } from "./jsonrpc.js";
import { SESSION_HEADER, SessionRegistry, type Session } from "./sessions.js";
import { pumpStream } from "./streams.js";

// Handle returned by `runHttp` so callers can shut down the server
// programmatically (tests, embedded scenarios).
export interface HttpRuntimeHandle {
  port: number;
  // Stop the sidecar: end every session, run the plugin's `shutdown` hook,
  // close the SSE streams and stop listening.
  close(): Promise<void>;
}

// Drive `plugin` over the streamable-HTTP contract on `host:port`.
//
// - `POST /` decodes a JSON-RPC request from the body, runs
//   `dispatch`, returns the response (or stream ack) in the body.
// - `GET  /` returns a long-lived Server-Sent-Events stream the
//   runtime pushes server notifications onto
//   (`$/stream/data` / `$/stream/end`, `$/channel/data` /
//   `$/channel/closed`).
//
// Same JSON-RPC semantics as the stdio runtime — both go through
// the shared `dispatch` helper. What differs is who the sidecar belongs to:
// over http it serves several hosts, each named by the `Bowire-Session`
// header it sends (see `Session`). A host's `shutdown` ends its session and
// the sidecar keeps serving; the plugin's own `shutdown` hook runs in
// `close()`, when the sidecar stops.
export async function runHttp(
  plugin: BowirePlugin,
  host = "127.0.0.1",
  port = 0,
): Promise<HttpRuntimeHandle> {
  const sessions = new SessionRegistry();
  const responses = new Set<ServerResponse>();

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }

    if (req.method === "GET") {
      handleSubscribe(req, res, sessions, responses);
      return;
    }

    if (req.method === "POST") {
      await handlePost(req, res, plugin, sessions);
      return;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    // The closing frames go out while the SSE streams are still open.
    await sessions.endAll();
    if (plugin.shutdown) await plugin.shutdown();
    for (const res of responses) {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
    responses.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    port: addr.port,
    // A second call waits for the first: the hook runs once.
    close: () => (closing ??= close()),
  };
}

function sessionOf(req: IncomingMessage, sessions: SessionRegistry): Session {
  const header = req.headers[SESSION_HEADER];
  return sessions.of(Array.isArray(header) ? header[0] : header);
}

function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionRegistry,
  responses: Set<ServerResponse>,
): void {
  const session = sessionOf(req, sessions);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  session.attach(res);
  responses.add(res);

  res.on("close", () => {
    responses.delete(res);
    // The last SSE stream of a session closing is its host leaving without
    // a word: a crash, or a network that went away.
    if (session.detach(res)) void sessions.end(session);
  });
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  plugin: BowirePlugin,
  sessions: SessionRegistry,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  let parsed: Request;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  const session = sessionOf(req, sessions);
  const outcome = await dispatch(plugin, parsed, session.channels);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");

  if (outcome.kind === "shutdown") {
    // The host is leaving, the sidecar is not. Without a session id there
    // is no telling which host that is, so nothing ends.
    if (session.id !== undefined) await sessions.end(session);
    res.end(JSON.stringify(outcome.response));
    return;
  }

  if (outcome.kind === "reply") {
    res.end(JSON.stringify(outcome.response));
    sessions.forgetIfIdle(session);
    return;
  }

  // streaming — ack now, pump frames onto the session's SSE streams
  res.end(JSON.stringify(outcome.ack));
  session.track(pumpStream(outcome.streamId, outcome.stream, session.notify));
}
