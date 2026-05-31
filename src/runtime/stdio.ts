import { createInterface } from "node:readline";
import type { BowirePlugin } from "../plugin.js";
import { dispatch } from "./dispatch.js";
import type { Notification, Request, Response } from "./jsonrpc.js";

// Drive `plugin` over the NDJSON JSON-RPC contract on stdin/stdout.
// Resolves once the host sends `shutdown` or stdin closes.
//
// One JSON object per line, no framing headers (mirrors the Python
// and Rust SDKs). Server-initiated frames are written as
// notifications (`{"jsonrpc":"2.0","method":"..."}`); replies always
// carry the request id back.
export async function run(plugin: BowirePlugin): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const writeFrame = (frame: Response | Notification) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  let stop = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let req: Request;
    try {
      req = JSON.parse(trimmed) as Request;
    } catch {
      // ignore malformed line — host violated the framing
      continue;
    }

    const outcome = await dispatch(plugin, req);

    if (outcome.kind === "reply") {
      writeFrame(outcome.response);
    } else if (outcome.kind === "shutdown") {
      writeFrame(outcome.response);
      stop = true;
    } else {
      writeFrame(outcome.ack);
      pumpStream(outcome.streamId, outcome.stream, writeFrame);
    }

    if (stop) break;
  }

  rl.close();
}

async function pumpStream(
  streamId: string,
  stream: AsyncIterable<string>,
  writeFrame: (n: Notification) => void,
): Promise<void> {
  try {
    for await (const message of stream) {
      writeFrame({
        jsonrpc: "2.0",
        method: "$/stream/data",
        params: { streamId, message },
      });
    }
  } finally {
    writeFrame({
      jsonrpc: "2.0",
      method: "$/stream/end",
      params: { streamId },
    });
  }
}
