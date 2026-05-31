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
// Optional: invokeStream, openChannel, settings, shutdown — defaults
// in `BowirePluginBase` cover the common case.
export interface BowirePlugin {
  id(): string;
  name(): string;

  discover(
    endpoint: string,
    refresh: boolean,
  ): Promise<ServiceInfo[]> | ServiceInfo[];

  invoke(
    endpoint: string,
    service: string,
    method: string,
    body: string[],
    streaming: boolean,
    metadata: Metadata,
  ): Promise<InvokeResult> | InvokeResult;

  invokeStream?(
    endpoint: string,
    service: string,
    method: string,
    body: string[],
    metadata: Metadata,
  ): AsyncIterable<InvokeStreamChunk>;

  openChannel?(
    endpoint: string,
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
    endpoint: string,
    refresh: boolean,
  ): Promise<ServiceInfo[]> | ServiceInfo[];
  abstract invoke(
    endpoint: string,
    service: string,
    method: string,
    body: string[],
    streaming: boolean,
    metadata: Metadata,
  ): Promise<InvokeResult> | InvokeResult;

  async *invokeStream(
    _endpoint: string,
    _service: string,
    _method: string,
    _body: string[],
    _metadata: Metadata,
  ): AsyncIterable<InvokeStreamChunk> {
    // empty stream by default
  }

  async openChannel(
    _endpoint: string,
    _service: string,
    _method: string,
    _metadata: Metadata,
    _channel: ChannelHandle,
  ): Promise<void> {
    // no-op; subclasses override for duplex protocols
  }

  settings(): PluginSetting[] {
    return [];
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
