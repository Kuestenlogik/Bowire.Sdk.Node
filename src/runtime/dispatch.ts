import { randomUUID } from "node:crypto";
import type { BowirePlugin, Metadata } from "../plugin.js";
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  err,
  ok,
  type Request,
  type Response,
} from "./jsonrpc.js";

// Result of dispatching a single inbound JSON-RPC request. Transport
// runtimes (stdio, http) translate this into the right wire effect:
// `reply` lands in the response body; `stream` returns the ack and
// pumps the iterable as `$/stream/data` notifications; `shutdown`
// returns the ack and signals the runtime to stop.
export type DispatchResult =
  | { kind: "reply"; response: Response }
  | {
      kind: "stream";
      ack: Response;
      streamId: string;
      stream: AsyncIterable<string>;
    }
  | { kind: "shutdown"; response: Response };

// The wire shapes the host sends. These used to read `endpoint`,
// `refresh`, `body` and `streaming` — names this SDK invented. The host
// sends `serverUrl`, `showInternalServices`, `jsonMessages` and mints the
// `streamId` itself, so every discover arrived with an empty URL, every
// invoke with no messages, and every stream frame was published under an
// id nobody was listening for. See the Bowire repo's
// docs/architecture/sidecar-plugins.md for the contract.
interface InvokeParams {
  serverUrl?: string;
  service?: string;
  method?: string;
  jsonMessages?: string[];
  showInternalServices?: boolean;
  metadata?: Metadata;
  streamId?: string;
}

interface DiscoverParams {
  serverUrl?: string;
  showInternalServices?: boolean;
}

// The sidecar wire-contract version this SDK speaks (#416). A sidecar that
// sends none is tolerated as contract v1 with a warning on every host boot;
// one outside the host's range is refused at the handshake instead of
// failing at the first call.
export const SIDECAR_PROTOCOL_VERSION = 1;

// What this plugin can actually answer. A `false` lets the host skip the
// call: `channels: false` short-circuits openChannel without a round-trip,
// which is the honest answer here because this dispatcher has no
// openChannel case at all — the interface declares one, nothing routes to
// it. Optional methods are read off the object, so a plugin that omits
// invokeStream stops being asked.
function capabilities(plugin: BowirePlugin): Record<string, boolean> {
  return {
    discover: typeof plugin.discover === "function",
    invoke: typeof plugin.invoke === "function",
    invokeStream: typeof plugin.invokeStream === "function",
    channels: false,
  };
}

export async function dispatch(
  plugin: BowirePlugin,
  req: Request,
): Promise<DispatchResult> {
  const id = req.id ?? null;
  const params = (req.params ?? {}) as Record<string, unknown>;

  try {
    switch (req.method) {
      case "shutdown": {
        if (plugin.shutdown) await plugin.shutdown();
        return { kind: "shutdown", response: ok(id, {}) };
      }

      case "initialize": {
        return {
          kind: "reply",
          response: ok(id, {
            id: plugin.id(),
            name: plugin.name(),
            iconSvg: plugin.iconSvg ? plugin.iconSvg() : "",
            settings: plugin.settings ? await plugin.settings() : [],
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            capabilities: capabilities(plugin),
          }),
        };
      }

      case "ping": {
        // The contract's reply is the bare string. `{pong:true}` was this
        // SDK's own invention.
        return { kind: "reply", response: ok(id, "pong") };
      }

      case "discover": {
        const dp = params as DiscoverParams;
        const services = await plugin.discover(
          dp.serverUrl ?? "",
          dp.showInternalServices ?? false,
        );
        // A bare array: the host reads anything else as "no services" and
        // moves on to the next plugin, silently.
        return { kind: "reply", response: ok(id, services) };
      }

      case "invoke": {
        const p = params as InvokeParams;
        const result = await plugin.invoke(
          p.serverUrl ?? "",
          p.service ?? "",
          p.method ?? "",
          p.jsonMessages ?? [],
          p.showInternalServices ?? false,
          p.metadata ?? {},
        );
        return { kind: "reply", response: ok(id, result) };
      }

      case "invokeStream": {
        if (!plugin.invokeStream) {
          return {
            kind: "reply",
            response: err(id, ERR_METHOD_NOT_FOUND, "invokeStream not supported"),
          };
        }
        const p = params as InvokeParams;
        // The host mints the id and subscribes to it *before* sending the
        // request, so a self-minted one publishes frames into a channel
        // nobody reads. randomUUID stays only as a fallback for a caller
        // that omits it (the HTTP smoke tests do).
        const streamId = p.streamId ?? randomUUID();
        const stream = plugin.invokeStream(
          p.serverUrl ?? "",
          p.service ?? "",
          p.method ?? "",
          p.jsonMessages ?? [],
          p.metadata ?? {},
        );
        return {
          kind: "stream",
          ack: ok(id, { streamId }),
          streamId,
          stream,
        };
      }

      default:
        return {
          kind: "reply",
          response: err(id, ERR_METHOD_NOT_FOUND, `unknown method: ${req.method}`),
        };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = isInvalidParams(e) ? ERR_INVALID_PARAMS : ERR_INTERNAL;
    return { kind: "reply", response: err(id, code, message) };
  }
}

function isInvalidParams(e: unknown): boolean {
  return e instanceof TypeError;
}
