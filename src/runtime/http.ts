import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BowirePlugin } from "../plugin.js";
import { dispatch } from "./dispatch.js";
import type { Notification, Request } from "./jsonrpc.js";

// Handle returned by `runHttp` so callers can shut down the server
// programmatically (tests, embedded scenarios).
export interface HttpRuntimeHandle {
  port: number;
  close(): Promise<void>;
}

// Drive `plugin` over the streamable-HTTP contract on `host:port`.
//
// - `POST /` decodes a JSON-RPC request from the body, runs
//   `dispatch`, returns the response (or stream ack) in the body.
// - `GET  /` returns a long-lived Server-Sent-Events stream the
//   runtime pushes server notifications onto
//   (`$/stream/data` / `$/stream/end`).
//
// Same JSON-RPC semantics as the stdio runtime — both go through
// the shared `dispatch` helper.
export async function runHttp(
  plugin: BowirePlugin,
  host = "127.0.0.1",
  port = 0,
): Promise<HttpRuntimeHandle> {
  const subscribers = new Set<ServerResponse>();

  const broadcast = (n: Notification) => {
    const payload = `data: ${JSON.stringify(n)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        // dropped — handled by 'close' cleanup
      }
    }
  };

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }

    if (req.method === "GET") {
      handleSubscribe(req, res, subscribers);
      return;
    }

    if (req.method === "POST") {
      await handlePost(req, res, plugin, broadcast);
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

  return {
    port: addr.port,
    async close(): Promise<void> {
      for (const res of subscribers) {
        try {
          res.end();
        } catch {
          // already closed
        }
      }
      subscribers.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  subscribers: Set<ServerResponse>,
): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  subscribers.add(res);

  const cleanup = () => {
    subscribers.delete(res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  plugin: BowirePlugin,
  broadcast: (n: Notification) => void,
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

  const outcome = await dispatch(plugin, parsed);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");

  if (outcome.kind === "reply" || outcome.kind === "shutdown") {
    res.end(JSON.stringify(outcome.response));
    return;
  }

  // streaming — ack now, pump frames onto the SSE broadcast
  res.end(JSON.stringify(outcome.ack));
  pumpStream(outcome.streamId, outcome.stream, broadcast);
}

async function pumpStream(
  streamId: string,
  stream: AsyncIterable<string>,
  broadcast: (n: Notification) => void,
): Promise<void> {
  try {
    for await (const message of stream) {
      broadcast({
        jsonrpc: "2.0",
        method: "$/stream/data",
        params: { streamId, message },
      });
    }
  } finally {
    broadcast({
      jsonrpc: "2.0",
      method: "$/stream/end",
      params: { streamId },
    });
  }
}
