import type {
  InvokeResult,
  PluginSetting,
  ServiceInfo,
} from "./models.js";

// Streaming response yielded by `invokeStream`. The runtime wraps
// each yielded payload as a `$/stream/data` notification.
export type InvokeStreamChunk = string;

// Headers / metadata bag passed to invoke calls — flat string map
// mirrors the wire shape.
export type Metadata = Record<string, string>;

// Channel side passed to `openChannel` — the plugin can call
// `send` to push messages to the workbench. `onMessage` is called
// for every message the workbench pushes back. Best-effort:
// duplex isn't required, default impl is a no-op.
export interface ChannelHandle {
  send(message: string): void;
  onMessage(handler: (message: string) => void | Promise<void>): void;
  onClose(handler: () => void | Promise<void>): void;
}

// The plugin contract every Bowire sidecar implements.
//
// Required: id, name, discover, invoke.
// Optional: iconSvg, invokeStream, openChannel, settings, shutdown —
// defaults in `BowirePluginBase` cover the common case.
//
// Parameter names are the host's, deliberately: `serverUrl`,
// `showInternalServices`, `jsonMessages` are what arrives on the wire
// (see the Bowire repo's docs/architecture/sidecar-plugins.md). They used
// to read `endpoint` / `refresh` / `body` here, which is why every
// discover call reached a plugin with an empty URL.
export interface BowirePlugin {
  id(): string;
  name(): string;

  // Inline SVG for the protocol tab. Optional — the host falls back to a
  // generic plug icon when absent.
  iconSvg?(): string;

  discover(
    serverUrl: string,
    showInternalServices: boolean,
  ): Promise<ServiceInfo[]> | ServiceInfo[];

  invoke(
    serverUrl: string,
    service: string,
    method: string,
    jsonMessages: string[],
    showInternalServices: boolean,
    metadata: Metadata,
  ): Promise<InvokeResult> | InvokeResult;

  invokeStream?(
    serverUrl: string,
    service: string,
    method: string,
    jsonMessages: string[],
    metadata: Metadata,
  ): AsyncIterable<InvokeStreamChunk>;

  openChannel?(
    serverUrl: string,
    service: string,
    method: string,
    metadata: Metadata,
    channel: ChannelHandle,
  ): Promise<void> | void;

  settings?(): Promise<PluginSetting[]> | PluginSetting[];

  shutdown?(): Promise<void> | void;
}

// Convenience base — subclass and override only what you need.
// Default `invokeStream` is an empty stream; default `openChannel`
// closes immediately; default `settings` returns `[]`; default
// `shutdown` is a no-op. Matches the Python/Rust SDK defaults.
export abstract class BowirePluginBase implements BowirePlugin {
  abstract id(): string;
  abstract name(): string;
  abstract discover(
    serverUrl: string,
    showInternalServices: boolean,
  ): Promise<ServiceInfo[]> | ServiceInfo[];
  abstract invoke(
    serverUrl: string,
    service: string,
    method: string,
    jsonMessages: string[],
    showInternalServices: boolean,
    metadata: Metadata,
  ): Promise<InvokeResult> | InvokeResult;

  async *invokeStream(
    _serverUrl: string,
    _service: string,
    _method: string,
    _jsonMessages: string[],
    _metadata: Metadata,
  ): AsyncIterable<InvokeStreamChunk> {
    // empty stream by default
  }

  async openChannel(
    _serverUrl: string,
    _service: string,
    _method: string,
    _metadata: Metadata,
    _channel: ChannelHandle,
  ): Promise<void> {
    // no-op; subclasses override for duplex protocols
  }

  // The host falls back to a generic plug icon on an empty string, so a
  // plugin that does not care about its tab icon overrides nothing.
  iconSvg(): string {
    return "";
  }

  settings(): PluginSetting[] {
    return [];
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
