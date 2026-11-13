import { createInterface } from "node:readline";
import type { BowirePlugin } from "../plugin.js";
import { ChannelRegistry } from "./channels.js";
import { dispatch } from "./dispatch.js";
import type { Notification, Request, Response } from "./jsonrpc.js";
import { pumpStream } from "./streams.js";

// Drive `plugin` over the NDJSON JSON-RPC contract on stdin/stdout.
// Resolves once the host sends `shutdown` or stdin closes. Either way the
// process is stopping: over stdio the host owns the sidecar, so every open
// channel closes and the plugin's `shutdown` hook runs, once.
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

  const channels = new ChannelRegistry(writeFrame);
  let stopped = false;

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

    const outcome = await dispatch(plugin, req, channels);

    if (outcome.kind === "reply") {
      writeFrame(outcome.response);
    } else if (outcome.kind === "shutdown") {
      // Channels first, so the host's read streams end and the plugin's
      // onClose handlers run before it is torn down; the reply last, so the
      // host hears "done" only once it is.
      await stopPlugin(plugin, channels);
      stopped = true;
      writeFrame(outcome.response);
      break;
    } else {
      writeFrame(outcome.ack);
      pumpStream(outcome.streamId, outcome.stream, writeFrame);
    }
  }

  // stdin closed without a shutdown: the host is gone. The plugin is told
  // all the same, so it can release what it and its channels hold.
  if (!stopped) await stopPlugin(plugin, channels);
  rl.close();
}

async function stopPlugin(plugin: BowirePlugin, channels: ChannelRegistry): Promise<void> {
  await channels.closeAll();
  if (plugin.shutdown) await plugin.shutdown();
}
