import type {
  InvokeResult,
  PluginSetting,
  ServiceInfo,
} from "./models.js";
import type { SettingValues } from "./settings.js";
import type { ManualEntryForm } from "./manual-entry.js";

// Streaming response yielded by `invokeStream`. The runtime wraps
// each yielded payload as a `$/stream/data` notification.
export type InvokeStreamChunk = string;

// Headers / metadata bag passed to invoke calls — flat string map
// mirrors the wire shape.
export type Metadata = Record<string, string>;

// The plugin's end of a duplex channel, passed to `openChannel` (#4).
//
// - `send` pushes a frame to the host as `$/channel/data`. It returns false
//   once the channel is closed and the host no longer reads.
// - `onMessage` handlers receive every frame the host sends
//   (`channel.send`), in order. Register them inside `openChannel`: the host
//   sends nothing before the open is answered.
// - `close` ends the channel from the plugin's side; the host's read stream
//   ends with it.
// - `onClose` handlers run exactly once when the channel ends, whichever
//   side closed it, before the host is told. They may still `send` a last
//   frame.
//
// `id` is the id the host minted for the channel.
export interface ChannelHandle {
  readonly id: string;
  // True once either side has started closing.
  readonly closed: boolean;
  send(message: string): boolean;
  close(): Promise<void>;
  onMessage(handler: (message: string) => void | Promise<void>): void;
  onClose(handler: () => void | Promise<void>): void;
}

// The plugin contract every Bowire sidecar implements.
//
// Required: id, name, discover, invoke.
// Optional: iconSvg, invokeStream, openChannel, settings, manualEntry, shutdown —
// defaults in `BowirePluginBase` cover the common case.
//
// Parameter names are the host's, deliberately: `serverUrl`,
// `showInternalServices`, `jsonMessages` are what arrives on the wire
// (see the Bowire repo's docs/architecture/sidecar-plugins.md). They used
// to read `endpoint` / `refresh` / `body` here, which is why every
// discover call reached a plugin with an empty URL.
//
// `settings` is the last argument of every call the host makes: the values
// behind what `settings()` declared (#693), fresh per call. A plugin that
// declares none can leave the parameter off.
export interface BowirePlugin {
  id(): string;
  name(): string;

  // Inline SVG for the protocol tab. Optional — the host falls back to a
  // generic plug icon when absent.
  iconSvg?(): string;

  discover(
    serverUrl: string,
    showInternalServices: boolean,
    settings: SettingValues,
  ): Promise<ServiceInfo[]> | ServiceInfo[];

  invoke(
    serverUrl: string,
    service: string,
    method: string,
    jsonMessages: string[],
    showInternalServices: boolean,
    metadata: Metadata,
    settings: SettingValues,
  ): Promise<InvokeResult> | InvokeResult;

  invokeStream?(
    serverUrl: string,
    service: string,
    method: string,
    jsonMessages: string[],
    metadata: Metadata,
    settings: SettingValues,
  ): AsyncIterable<InvokeStreamChunk>;

  openChannel?(
    serverUrl: string,
    service: string,
    method: string,
    metadata: Metadata,
    channel: ChannelHandle,
    settings: SettingValues,
  ): Promise<void> | void;

  settings?(): Promise<PluginSetting[]> | PluginSetting[];

  // How a call is entered by hand (Kuestenlogik/Bowire#1003): put in the
  // `initialize` reply as `manualEntry`. Leave it off, or return undefined,
  // and the host offers no form for this plugin.
  manualEntry?(): Promise<ManualEntryForm | undefined> | ManualEntryForm | undefined;

  shutdown?(): Promise<void> | void;
}

// Convenience base — subclass and override only what you need.
// Default `invokeStream` is an empty stream; default `settings` returns
// `[]`; default `shutdown` is a no-op. Matches the Python/Rust SDK
// defaults.
//
// `openChannel` has no default on purpose: whether a plugin has one is what
// `capabilities.channels` reports, and a no-op default would claim duplex
// support for every subclass.
export abstract class BowirePluginBase implements BowirePlugin {
  abstract id(): string;
  abstract name(): string;
  abstract discover(
    serverUrl: string,
    showInternalServices: boolean,
    settings: SettingValues,
  ): Promise<ServiceInfo[]> | ServiceInfo[];
  abstract invoke(
    serverUrl: string,
    service: string,
    method: string,
    jsonMessages: string[],
    showInternalServices: boolean,
    metadata: Metadata,
    settings: SettingValues,
  ): Promise<InvokeResult> | InvokeResult;

  async *invokeStream(
    _serverUrl: string,
    _service: string,
    _method: string,
    _jsonMessages: string[],
    _metadata: Metadata,
    _settings: SettingValues,
  ): AsyncIterable<InvokeStreamChunk> {
    // empty stream by default
  }

  // Declared, not implemented — see above. Override it to serve duplex
  // methods; the host then routes channel.send / channel.close to the
  // handle it is given.
  openChannel?(
    serverUrl: string,
    service: string,
    method: string,
    metadata: Metadata,
    channel: ChannelHandle,
    settings: SettingValues,
  ): Promise<void> | void;

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
