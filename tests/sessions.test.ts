// Sessions over http (Kuestenlogik/Bowire#1014): one sidecar, several hosts.
// A host names itself with the `Bowire-Session` header; what it opens is its
// own, its notifications reach only it, and when it leaves (a `shutdown`, or
// its SSE stream closing) only its things end.
//
// Every test runs its own server, and every wait is for a frame or a
// handler that says the thing happened. Nothing here waits on time.

import { describe, it, expect } from "vitest";
import {
  BowirePluginBase,
  ERR_CHANNEL_CLOSED,
  InvokeResult,
  ServiceInfo,
  runHttp,
  type ChannelHandle,
  type HttpRuntimeHandle,
  type Metadata,
} from "../src/index.js";
import type { Notification } from "../src/runtime/jsonrpc.js";

interface Signal {
  readonly promise: Promise<void>;
  resolve(): void;
}

function signal(): Signal {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

class SessionPlugin extends BowirePluginBase {
  shutdowns = 0;
  readonly streamEnded = signal();
  private readonly closed = new Map<string, Signal>();

  // Resolves once the onClose handler of the channel opened as `method` ran.
  channelClosed(method: string): Promise<void> {
    return this.closedSignal(method).promise;
  }

  private closedSignal(method: string): Signal {
    let s = this.closed.get(method);
    if (!s) this.closed.set(method, (s = signal()));
    return s;
  }

  override id(): string {
    return "sessions";
  }
  override name(): string {
    return "Sessions";
  }
  override discover(): ServiceInfo[] {
    return [];
  }
  override invoke(): InvokeResult {
    return InvokeResult.ok("{}");
  }
  // Ticks until it is told to stop. Each tick gives the event loop a turn,
  // the way a stream that reads from a socket would.
  override async *invokeStream(): AsyncIterable<string> {
    try {
      for (let i = 0; ; i++) {
        yield `tick-${i}`;
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      this.streamEnded.resolve();
    }
  }
  override openChannel(
    _serverUrl: string,
    _service: string,
    method: string,
    _metadata: Metadata,
    channel: ChannelHandle,
  ): void {
    channel.onMessage((m) => {
      channel.send(`${method}:${m}`);
    });
    channel.onClose(() => this.closedSignal(method).resolve());
  }
  override async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

type Reply = { result?: unknown; error?: { code: number } };

// One host: an SSE stream and the POSTs that go with it, under one session
// id (or none, for a host older than the rule).
class Host {
  readonly frames: Notification[] = [];
  private readonly ctrl = new AbortController();
  private waiters: (() => void)[] = [];
  private nextId = 1;

  private constructor(
    private readonly base: string,
    private readonly session: string | undefined,
  ) {}

  static async connect(base: string, session?: string): Promise<Host> {
    const host = new Host(base, session);
    const sse = await fetch(`${base}/`, { headers: host.headers(), signal: host.ctrl.signal });
    expect(sse.status).toBe(200);
    void host.read(sse.body!.getReader());
    return host;
  }

  private headers(): Record<string, string> {
    return this.session === undefined ? {} : { "Bowire-Session": this.session };
  }

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const e of events) {
          this.frames.push(JSON.parse(e.replace(/^data:\s*/, "")) as Notification);
        }
        for (const wake of this.waiters.splice(0)) wake();
      }
    } catch {
      // disconnected
    }
  }

  // The first frame matching `match`, whether it already arrived or not.
  async frame(match: (n: Notification) => boolean): Promise<Notification> {
    for (;;) {
      const found = this.frames.find(match);
      if (found) return found;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  async post(method: string, params?: unknown): Promise<Reply> {
    const res = await fetch(`${this.base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    return (await res.json()) as Reply;
  }

  // Drop the SSE stream without a word, as a crashed host would.
  disconnect(): void {
    this.ctrl.abort();
  }
}

// A notification's params, as the fields these tests read.
function params(n: Notification): { channelId?: string; streamId?: string; message?: string } {
  return (n.params ?? {}) as { channelId?: string; streamId?: string; message?: string };
}

const data = (channelId: string, message: string) => (n: Notification) =>
  n.method === "$/channel/data" &&
  params(n).channelId === channelId &&
  params(n).message === message;

const closed = (channelId: string) => (n: Notification) =>
  n.method === "$/channel/closed" && params(n).channelId === channelId;

async function sidecar(): Promise<{
  plugin: SessionPlugin;
  handle: HttpRuntimeHandle;
  base: string;
}> {
  const plugin = new SessionPlugin();
  const handle = await runHttp(plugin, "127.0.0.1", 0);
  return { plugin, handle, base: `http://127.0.0.1:${handle.port}` };
}

describe("http sessions", () => {
  it("a host that leaves takes its own channel and leaves the other's open", async () => {
    const { plugin, handle, base } = await sidecar();
    const a = await Host.connect(base, "host-a");
    const b = await Host.connect(base, "host-b");

    // The same channel id under both: ids are minted per host, and a
    // session keeps its own.
    expect((await a.post("openChannel", { channelId: "c", method: "a" })).error).toBeUndefined();
    expect((await b.post("openChannel", { channelId: "c", method: "b" })).error).toBeUndefined();

    expect((await a.post("shutdown")).error).toBeUndefined();

    await a.frame(closed("c"));
    await plugin.channelClosed("a");
    expect((await a.post("channel.send", { channelId: "c", message: "x" })).error?.code).toBe(
      ERR_CHANNEL_CLOSED,
    );

    expect((await b.post("channel.send", { channelId: "c", message: "x" })).error).toBeUndefined();
    await b.frame(data("c", "b:x"));
    expect(b.frames.some(closed("c"))).toBe(false);

    // The host left; the sidecar did not stop.
    expect(plugin.shutdowns).toBe(0);
    await handle.close();
  });

  it("a host reads its own notifications and nobody else's", async () => {
    const { handle, base } = await sidecar();
    const a = await Host.connect(base, "host-a");
    const b = await Host.connect(base, "host-b");

    await b.post("openChannel", { channelId: "b1", method: "b" });
    await b.post("channel.send", { channelId: "b1", message: "secret" });
    await b.frame(data("b1", "b:secret"));

    // A's own frame is written after B's, so by the time it arrives
    // anything of B's that was going to reach A has.
    await a.post("openChannel", { channelId: "a1", method: "a" });
    await a.post("channel.send", { channelId: "a1", message: "mine" });
    await a.frame(data("a1", "a:mine"));

    expect(a.frames.map((n) => params(n).channelId)).toEqual(["a1"]);
    expect(b.frames.map((n) => params(n).channelId)).toEqual(["b1"]);
    await handle.close();
  });

  it("a session whose SSE stream closes ends as if it had said shutdown", async () => {
    const { plugin, handle, base } = await sidecar();
    const a = await Host.connect(base, "host-a");
    const b = await Host.connect(base, "host-b");
    await a.post("openChannel", { channelId: "a1", method: "a" });
    await b.post("openChannel", { channelId: "b1", method: "b" });

    a.disconnect();
    await plugin.channelClosed("a");

    expect((await b.post("channel.send", { channelId: "b1", message: "x" })).error).toBeUndefined();
    await b.frame(data("b1", "b:x"));
    expect(plugin.shutdowns).toBe(0);
    await handle.close();
  });

  it("a host reaches only the channels of its own session", async () => {
    const { handle, base } = await sidecar();
    const a = await Host.connect(base, "host-a");
    const b = await Host.connect(base, "host-b");
    await a.post("openChannel", { channelId: "a1", method: "a" });

    expect((await b.post("channel.send", { channelId: "a1", message: "x" })).error?.code).toBe(
      ERR_CHANNEL_CLOSED,
    );
    expect((await b.post("channel.close", { channelId: "a1" })).error?.code).toBe(
      ERR_CHANNEL_CLOSED,
    );

    expect((await a.post("channel.send", { channelId: "a1", message: "x" })).error).toBeUndefined();
    await a.frame(data("a1", "a:x"));
    await handle.close();
  });

  it("a leaving host's stream stops", async () => {
    const { plugin, handle, base } = await sidecar();
    const a = await Host.connect(base, "host-a");
    await a.post("invokeStream", { streamId: "s1" });
    await a.frame((n) => n.method === "$/stream/data" && params(n).streamId === "s1");

    await a.post("shutdown");

    await plugin.streamEnded.promise;
    await a.frame((n) => n.method === "$/stream/end" && params(n).streamId === "s1");
    await handle.close();
  });

  it("a shutdown without a session id ends nothing", async () => {
    const { plugin, handle, base } = await sidecar();
    const old = await Host.connect(base);
    await old.post("openChannel", { channelId: "o1", method: "old" });

    expect((await old.post("shutdown")).error).toBeUndefined();

    expect((await old.post("channel.send", { channelId: "o1", message: "x" })).error)
      .toBeUndefined();
    await old.frame(data("o1", "old:x"));
    expect(plugin.shutdowns).toBe(0);
    await handle.close();
  });

  it("hosts without a session id share their notifications, apart from the named ones", async () => {
    const { handle, base } = await sidecar();
    const old1 = await Host.connect(base);
    const old2 = await Host.connect(base);
    const named = await Host.connect(base, "host-a");

    await old1.post("openChannel", { channelId: "o1", method: "old" });
    await old1.post("channel.send", { channelId: "o1", message: "x" });
    await old1.frame(data("o1", "old:x"));
    await old2.frame(data("o1", "old:x"));

    await named.post("openChannel", { channelId: "n1", method: "named" });
    await named.post("channel.send", { channelId: "n1", message: "y" });
    await named.frame(data("n1", "named:y"));
    expect(named.frames.map((n) => params(n).channelId)).toEqual(["n1"]);
    await handle.close();
  });

  it("the plugin's shutdown hook runs once, when the sidecar stops", async () => {
    const { plugin, handle, base } = await sidecar();
    const a = await Host.connect(base, "host-a");
    await a.post("openChannel", { channelId: "a1", method: "a" });

    await Promise.all([handle.close(), handle.close()]);

    expect(plugin.shutdowns).toBe(1);
    // Stopping closed the channel first, and the host was told.
    await plugin.channelClosed("a");
    await a.frame(closed("a1"));
  });
});
