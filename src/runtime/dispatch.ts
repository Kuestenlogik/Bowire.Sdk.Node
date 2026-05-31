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

interface InvokeParams {
  endpoint?: string;
  service?: string;
  method?: string;
  body?: string[];
  streaming?: boolean;
  metadata?: Metadata;
}

interface DiscoverParams {
  endpoint?: string;
  refresh?: boolean;
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
            settings: plugin.settings ? await plugin.settings() : [],
          }),
        };
      }

      case "ping": {
        return { kind: "reply", response: ok(id, { pong: true }) };
      }

      case "discover": {
        const dp = params as DiscoverParams;
        const services = await plugin.discover(dp.endpoint ?? "", dp.refresh ?? false);
        return { kind: "reply", response: ok(id, { services }) };
      }

      case "invoke": {
        const p = params as InvokeParams;
        const result = await plugin.invoke(
          p.endpoint ?? "",
          p.service ?? "",
          p.method ?? "",
          p.body ?? [],
          p.streaming ?? false,
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
        const streamId = randomUUID();
        const stream = plugin.invokeStream(
          p.endpoint ?? "",
          p.service ?? "",
          p.method ?? "",
          p.body ?? [],
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
