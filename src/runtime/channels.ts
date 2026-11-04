import type { ChannelHandle } from "../plugin.js";
import type { Notification } from "./jsonrpc.js";

// Where a runtime puts server-initiated frames: stdout for stdio, the SSE
// broadcast for HTTP.
export type Notify = (n: Notification) => void;

type State = "open" | "closing" | "closed";

// One duplex channel, keyed by the id the host minted (#4).
//
// The host subscribes to the id before it sends `openChannel`, so every
// frame this pushes carries that id — a self-minted one would publish into a
// channel nobody reads.
//
// Closing runs the same way whichever side starts it: the plugin's onClose
// handlers run first (they may still push final frames), then
// `$/channel/closed` goes out and ends the host's read stream. The state
// guard makes that happen exactly once, so a close from both sides at the
// same time still yields one notification and one round of handlers.
export class HostChannel implements ChannelHandle {
  private state: State = "open";
  private readonly messageHandlers: ((message: string) => void | Promise<void>)[] = [];
  private readonly closeHandlers: (() => void | Promise<void>)[] = [];

  constructor(
    readonly id: string,
    private readonly notify: Notify,
    private readonly ended: (channel: HostChannel) => void,
  ) {}

  get closed(): boolean {
    return this.state !== "open";
  }

  // Frames are still accepted while the onClose handlers run, so a plugin
  // can answer a close with a last word. After that the host has stopped
  // reading and `send` reports false.
  send(message: string): boolean {
    if (this.state === "closed") return false;
    this.notify({
      jsonrpc: "2.0",
      method: "$/channel/data",
      params: { channelId: this.id, message },
    });
    return true;
  }

  close(): Promise<void> {
    return this.end();
  }

  onMessage(handler: (message: string) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void | Promise<void>): void {
    this.closeHandlers.push(handler);
  }

  // A `channel.send` from the host. Handlers run in order and are awaited,
  // so frames reach the plugin in the order the host sent them.
  async deliver(message: string): Promise<void> {
    for (const handler of this.messageHandlers) await handler(message);
  }

  // Close from either side. Resolves once `$/channel/closed` is out; a
  // second call while the first is under way is a no-op.
  async end(): Promise<void> {
    if (this.state !== "open") return;
    this.state = "closing";
    try {
      for (const handler of this.closeHandlers) await handler();
    } finally {
      // Even when a handler throws: the host's read stream must end, or it
      // waits for a frame that never comes.
      this.state = "closed";
      this.ended(this);
      this.notify({
        jsonrpc: "2.0",
        method: "$/channel/closed",
        params: { channelId: this.id },
      });
    }
  }
}

// The open channels of one runtime. Several can be open at once; each is
// reached only by its own id, so frames never cross.
export class ChannelRegistry {
  private readonly channels = new Map<string, HostChannel>();

  constructor(private readonly notify: Notify) {}

  get size(): number {
    return this.channels.size;
  }

  // Register a channel under the host's id. A second open with an id that is
  // still open is refused rather than silently replacing the first.
  open(id: string): HostChannel {
    if (this.channels.has(id)) throw new TypeError(`channel ${id} is already open`);
    const channel = new HostChannel(id, this.notify, (c) => {
      if (this.channels.get(c.id) === c) this.channels.delete(c.id);
    });
    this.channels.set(id, channel);
    return channel;
  }

  get(id: string): HostChannel | undefined {
    return this.channels.get(id);
  }

  // Drop a channel that never finished opening. No `$/channel/closed`: the
  // host got an error for the open and has already let the id go.
  discard(channel: HostChannel): void {
    if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id);
  }

  // Close every open channel — on shutdown, or when the host's wire is gone.
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.channels.values()].map((c) => c.end()));
  }
}
