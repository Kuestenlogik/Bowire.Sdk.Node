// Duplex channels (#4): openChannel / channel.send / channel.close routed by
// the host-minted channelId, frames pushed back as $/channel/data, and the
// end signalled as $/channel/closed exactly once — whichever side closes.
// Every step awaits the dispatcher's own reply, so nothing here waits on time.

import { describe, it, expect } from "vitest";
import {
  BowirePluginBase,
  ERR_CHANNEL_CLOSED,
  InvokeResult,
  PluginSetting,
  ServiceInfo,
  type ChannelHandle,
  type Metadata,
  type SettingValues,
} from "../src/index.js";
import { ChannelRegistry } from "../src/runtime/channels.js";
import { dispatch } from "../src/runtime/dispatch.js";
import type { Notification, Request, Response } from "../src/runtime/jsonrpc.js";

class ChatPlugin extends BowirePluginBase {
  readonly received: Record<string, string[]> = {};
  readonly closes: Record<string, number> = {};
  readonly handles: Record<string, ChannelHandle> = {};
  prefix = "";

  override id(): string {
    return "chat";
  }
  override name(): string {
    return "Chat";
  }
  override settings(): PluginSetting[] {
    return [new PluginSetting("prefix", "Prefix", "string").withDefault("echo:")];
  }
  override discover(): ServiceInfo[] {
    return [];
  }
  override invoke(): InvokeResult {
    return InvokeResult.ok("{}");
  }
  override openChannel(
    _serverUrl: string,
    _service: string,
    method: string,
    _metadata: Metadata,
    channel: ChannelHandle,
    settings: SettingValues,
  ): void {
    if (method === "refuse") throw new Error("no such duplex method");
    this.prefix = settings.string("prefix");
    this.handles[channel.id] = channel;
    this.received[channel.id] = [];
    this.closes[channel.id] = 0;
    channel.onMessage(async (message) => {
      this.received[channel.id]!.push(message);
      if (message === "bye") await channel.close();
      else channel.send(`${this.prefix}${message}`);
    });
    channel.onClose(() => {
      this.closes[channel.id]! += 1;
      // Still allowed: the host reads until $/channel/closed.
      channel.send("last word");
    });
  }
}

// A host stand-in: the registry's notify sink is the "wire" it reads.
class Host {
  readonly frames: Notification[] = [];
  readonly channels = new ChannelRegistry((n) => this.frames.push(n));
  private nextId = 1;

  constructor(readonly plugin: BowirePluginBase) {}

  async request(method: string, params?: unknown): Promise<Response> {
    const req: Request = { jsonrpc: "2.0", id: this.nextId++, method, params };
    const r = await dispatch(this.plugin, req, this.channels);
    if (r.kind === "stream") throw new Error("unexpected stream");
    return r.response;
  }

  open(channelId: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return this.request("openChannel", {
      channelId,
      serverUrl: "chat://demo",
      service: "Chat",
      method: "Talk",
      showInternalServices: false,
      metadata: {},
      ...extra,
    });
  }

  send(channelId: string, message: string): Promise<Response> {
    return this.request("channel.send", { channelId, message });
  }

  close(channelId: string): Promise<Response> {
    return this.request("channel.close", { channelId });
  }

  // What the host's read stream for one channel saw.
  stream(channelId: string): { data: string[]; closed: number } {
    const mine = this.frames.filter(
      (f) => (f.params as { channelId?: string }).channelId === channelId,
    );
    return {
      data: mine
        .filter((f) => f.method === "$/channel/data")
        .map((f) => (f.params as { message: string }).message),
      closed: mine.filter((f) => f.method === "$/channel/closed").length,
    };
  }
}

describe("channels", () => {
  it("reports channels: true only for a plugin that implements openChannel", async () => {
    class NoChannels extends BowirePluginBase {
      override id(): string {
        return "plain";
      }
      override name(): string {
        return "Plain";
      }
      override discover(): ServiceInfo[] {
        return [];
      }
      override invoke(): InvokeResult {
        return InvokeResult.ok("{}");
      }
    }
    const caps = async (plugin: BowirePluginBase) => {
      const r = await new Host(plugin).request("initialize");
      return (r.result as { capabilities: Record<string, boolean> }).capabilities.channels;
    };
    expect(await caps(new ChatPlugin())).toBe(true);
    expect(await caps(new NoChannels())).toBe(false);

    const r = await new Host(new NoChannels()).open("x");
    expect(r.error?.code).toBe(-32601);
  });

  it("open, send both ways, close from the host", async () => {
    const plugin = new ChatPlugin();
    const host = new Host(plugin);

    const opened = await host.open("ab12");
    expect(opened.error).toBeUndefined();
    expect((opened.result as { channelId: string }).channelId).toBe("ab12");

    // host -> plugin, answered plugin -> host under the host's id
    expect((await host.send("ab12", "hello")).error).toBeUndefined();
    expect(plugin.received["ab12"]).toEqual(["hello"]);
    expect(host.stream("ab12")).toEqual({ data: ["echo:hello"], closed: 0 });

    // plugin -> host unprompted
    expect(plugin.handles["ab12"]!.send("push")).toBe(true);

    const closed = await host.close("ab12");
    expect(closed.error).toBeUndefined();
    expect(plugin.closes["ab12"]).toBe(1);
    expect(host.stream("ab12")).toEqual({
      data: ["echo:hello", "push", "last word"],
      closed: 1,
    });
    // $/channel/closed is the last frame for the channel.
    expect(host.frames.at(-1)?.method).toBe("$/channel/closed");
    expect(plugin.handles["ab12"]!.closed).toBe(true);
    expect(plugin.handles["ab12"]!.send("too late")).toBe(false);
  });

  it("a send after close returns the error the host reads as false", async () => {
    const host = new Host(new ChatPlugin());
    await host.open("c1");
    await host.close("c1");

    const r = await host.send("c1", "anyone?");
    expect(r.error?.code).toBe(ERR_CHANNEL_CLOSED);
    expect(r.result).toBeUndefined();

    const never = await host.send("never-opened", "x");
    expect(never.error?.code).toBe(ERR_CHANNEL_CLOSED);
  });

  it("a close from the plugin ends the host's stream exactly once", async () => {
    const plugin = new ChatPlugin();
    const host = new Host(plugin);
    await host.open("p1");

    await host.send("p1", "bye");
    expect(plugin.closes["p1"]).toBe(1);
    expect(host.stream("p1")).toEqual({ data: ["last word"], closed: 1 });

    // The host may still close its side; that changes nothing on the wire.
    await host.close("p1");
    await plugin.handles["p1"]!.close();
    expect(plugin.closes["p1"]).toBe(1);
    expect(host.stream("p1").closed).toBe(1);
    expect((await host.send("p1", "x")).error?.code).toBe(ERR_CHANNEL_CLOSED);
  });

  it("closing from both sides at once still closes once", async () => {
    const plugin = new ChatPlugin();
    const host = new Host(plugin);
    await host.open("both");

    await Promise.all([plugin.handles["both"]!.close(), host.close("both")]);
    expect(plugin.closes["both"]).toBe(1);
    expect(host.stream("both").closed).toBe(1);
  });

  it("two channels at once do not cross frames", async () => {
    const plugin = new ChatPlugin();
    const host = new Host(plugin);
    await host.open("one");
    await host.open("two");

    await host.send("one", "a");
    await host.send("two", "b");
    await host.send("one", "c");
    await host.close("two");

    expect(plugin.received).toEqual({ one: ["a", "c"], two: ["b"] });
    expect(host.stream("one")).toEqual({ data: ["echo:a", "echo:c"], closed: 0 });
    expect(host.stream("two")).toEqual({ data: ["echo:b", "last word"], closed: 1 });

    // "one" is untouched by closing "two".
    expect((await host.send("one", "d")).error).toBeUndefined();
    expect(host.stream("one").data).toEqual(["echo:a", "echo:c", "echo:d"]);
  });

  it("refuses a second open with an id that is still open", async () => {
    const host = new Host(new ChatPlugin());
    await host.open("dup");
    const r = await host.open("dup");
    expect(r.error?.code).toBe(-32602);
    expect((await host.send("dup", "x")).error).toBeUndefined();
  });

  it("a failed open leaves no channel behind and sends no close", async () => {
    const host = new Host(new ChatPlugin());
    const r = await host.open("bad", { method: "refuse" });
    expect(r.error?.message).toBe("no such duplex method");
    expect(host.channels.size).toBe(0);
    expect(host.frames).toEqual([]);
    expect((await host.send("bad", "x")).error?.code).toBe(ERR_CHANNEL_CLOSED);
  });

  it("openChannel receives the host's settings", async () => {
    const plugin = new ChatPlugin();
    const host = new Host(plugin);
    await host.open("s1", { settings: { prefix: ">> " } });
    await host.send("s1", "hi");
    expect(host.stream("s1").data).toEqual([">> hi"]);

    await host.open("s2");
    expect(plugin.prefix).toBe("echo:");
  });

  it("shutdown closes every open channel", async () => {
    const plugin = new ChatPlugin();
    const host = new Host(plugin);
    await host.open("x1");
    await host.open("x2");
    const r = await dispatch(plugin, { jsonrpc: "2.0", id: 99, method: "shutdown" }, host.channels);
    expect(r.kind).toBe("shutdown");
    expect(host.stream("x1").closed).toBe(1);
    expect(host.stream("x2").closed).toBe(1);
    expect(plugin.closes).toEqual({ x1: 1, x2: 1 });
    expect(host.channels.size).toBe(0);
  });
});
