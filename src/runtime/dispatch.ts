import { randomUUID } from "node:crypto";
import { manualEntryProblems } from "../manual-entry.js";
import type { BowirePlugin, Metadata } from "../plugin.js";
import { SettingValues } from "../settings.js";
import type { ChannelRegistry } from "./channels.js";
import {
  ERR_CHANNEL_CLOSED,
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
  settings?: unknown;
}

interface ChannelParams {
  channelId?: string;
  serverUrl?: string;
  service?: string;
  method?: string;
  metadata?: Metadata;
  settings?: unknown;
  message?: unknown;
}

interface DiscoverParams {
  serverUrl?: string;
  showInternalServices?: boolean;
  settings?: unknown;
}

// The sidecar wire-contract version this SDK speaks (#416). A sidecar that
// sends none is tolerated as contract v1 with a warning on every host boot;
// one outside the host's range is refused at the handshake instead of
// failing at the first call.
export const SIDECAR_PROTOCOL_VERSION = 1;

// What this plugin can actually answer. A `false` lets the host skip the
// call: `channels: false` short-circuits openChannel without a round-trip.
// Optional methods are read off the object, so a plugin that does not
// implement openChannel is not asked to open one.
function capabilities(plugin: BowirePlugin): Record<string, boolean> {
  return {
    discover: typeof plugin.discover === "function",
    invoke: typeof plugin.invoke === "function",
    invokeStream: typeof plugin.invokeStream === "function",
    channels: typeof plugin.openChannel === "function",
  };
}

// Route one inbound request. `channels` holds the open duplex channels of
// the runtime calling this; channel frames go out through the notify sink it
// was built with.
export async function dispatch(
  plugin: BowirePlugin,
  req: Request,
  channels: ChannelRegistry,
): Promise<DispatchResult> {
  const id = req.id ?? null;
  const params = (req.params ?? {}) as Record<string, unknown>;

  try {
    switch (req.method) {
      case "shutdown": {
        // Every open channel ends first, so the host's read streams end
        // and the plugin's onClose handlers run before it is torn down.
        await channels.closeAll();
        if (plugin.shutdown) await plugin.shutdown();
        return { kind: "shutdown", response: ok(id, {}) };
      }

      case "initialize": {
        // A form the host would refuse fails the handshake here, naming what
        // is wrong, rather than silently never appearing in the workbench.
        const manualEntry = plugin.manualEntry ? await plugin.manualEntry() : undefined;
        if (manualEntry) {
          const problems = manualEntryProblems(manualEntry);
          if (problems.length > 0) throw new Error("manualEntry: " + problems.join("; "));
        }
        return {
          kind: "reply",
          response: ok(id, {
            id: plugin.id(),
            name: plugin.name(),
            iconSvg: plugin.iconSvg ? plugin.iconSvg() : "",
            settings: plugin.settings ? await plugin.settings() : [],
            ...(manualEntry ? { manualEntry } : {}),
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
          await settingValues(plugin, dp.settings),
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
          await settingValues(plugin, p.settings),
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
          await settingValues(plugin, p.settings),
        );
        return {
          kind: "stream",
          ack: ok(id, { streamId }),
          streamId,
          stream,
        };
      }

      case "openChannel": {
        if (!plugin.openChannel) {
          return {
            kind: "reply",
            response: err(id, ERR_METHOD_NOT_FOUND, "openChannel not supported"),
          };
        }
        const p = params as ChannelParams;
        // Host-minted, like the streamId: the host subscribed to this id
        // before sending the request.
        const channelId = p.channelId ?? randomUUID();
        const channel = channels.open(channelId);
        try {
          await plugin.openChannel(
            p.serverUrl ?? "",
            p.service ?? "",
            p.method ?? "",
            p.metadata ?? {},
            channel,
            await settingValues(plugin, p.settings),
          );
        } catch (e) {
          channels.discard(channel);
          throw e;
        }
        return { kind: "reply", response: ok(id, { channelId }) };
      }

      case "channel.send": {
        const p = params as ChannelParams;
        const channel = p.channelId === undefined ? undefined : channels.get(p.channelId);
        if (!channel || channel.closed) return channelGone(id, p.channelId);
        const message =
          typeof p.message === "string" ? p.message : JSON.stringify(p.message ?? null);
        await channel.deliver(message);
        return { kind: "reply", response: ok(id, {}) };
      }

      case "channel.close": {
        const p = params as ChannelParams;
        const channel = p.channelId === undefined ? undefined : channels.get(p.channelId);
        if (!channel) return channelGone(id, p.channelId);
        // A close that races one already under way from the plugin's side
        // succeeds without a second round: the channel is ending either way.
        await channel.end();
        return { kind: "reply", response: ok(id, {}) };
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

// The error the host maps onto `IBowireChannel.SendAsync` returning false.
function channelGone(
  id: string | number | null,
  channelId: string | undefined,
): DispatchResult {
  return {
    kind: "reply",
    response: err(id, ERR_CHANNEL_CLOSED, `channel ${channelId ?? "(none)"} is closed`),
  };
}

// The values the host sent with this call (#693), read against what the
// plugin declares so an absent key resolves to the declared default. The
// declarations are asked for per call rather than captured at initialize: a
// plugin is free to compute them, and the cost is one method call.
async function settingValues(
  plugin: BowirePlugin,
  raw: unknown,
): Promise<SettingValues> {
  const declared = plugin.settings ? await plugin.settings() : [];
  return SettingValues.fromWire(raw, declared);
}

function isInvalidParams(e: unknown): boolean {
  return e instanceof TypeError;
}
