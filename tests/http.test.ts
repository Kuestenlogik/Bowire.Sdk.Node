// HTTP/SSE runtime round-trip: spin a real server on an ephemeral
// port, POST a JSON-RPC request, verify the response body. Also
// verifies the SSE subscriber receives `$/stream/data` notifications
// from an invokeStream invocation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  BowirePluginBase,
  InvokeResult,
  ServiceInfo,
  runHttp,
  type ChannelHandle,
  type HttpRuntimeHandle,
  type Metadata,
} from "../src/index.js";

class HttpTestPlugin extends BowirePluginBase {
  override id(): string {
    return "http-test";
  }
  override name(): string {
    return "HTTP Test";
  }
  override discover(): ServiceInfo[] {
    return [new ServiceInfo("Svc")];
  }
  override invoke(
    _endpoint: string,
    _service: string,
    method: string,
    _body: string[],
    _streaming: boolean,
    _metadata: Metadata,
  ): InvokeResult {
    return InvokeResult.ok(JSON.stringify({ method }));
  }
  override async *invokeStream(
    _endpoint: string,
    _service: string,
    _method: string,
    _body: string[],
    _metadata: Metadata,
  ): AsyncIterable<string> {
    yield "a";
    yield "b";
  }
  override openChannel(
    _serverUrl: string,
    _service: string,
    _method: string,
    _metadata: Metadata,
    channel: ChannelHandle,
  ): void {
    channel.onMessage((m) => {
      channel.send(`re:${m}`);
    });
  }
}

async function post(base: string, id: number, method: string, params: unknown) {
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { code: number } };
}

let handle: HttpRuntimeHandle;
let base: string;

beforeAll(async () => {
  handle = await runHttp(new HttpTestPlugin(), "127.0.0.1", 0);
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
});

describe("runHttp", () => {
  it("POST / runs unary invoke through dispatch", async () => {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "invoke",
        params: {
          endpoint: "x",
          service: "Svc",
          method: "Echo",
          body: [],
          streaming: false,
          metadata: {},
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: InvokeResult };
    expect(body.result.status).toBe("OK");
    expect(body.result.response).toBe('{"method":"Echo"}');
  });

  it("POST / with malformed body returns 400", async () => {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("GET / starts an SSE stream that carries invokeStream frames", async () => {
    const ctrl = new AbortController();
    const sse = await fetch(`${base}/`, { signal: ctrl.signal });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");

    // Kick off the stream. The ack lands in the POST body; data
    // frames arrive on the open SSE subscription above.
    const ackRes = await fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "invokeStream",
        params: { method: "Watch" },
      }),
    });
    const ack = (await ackRes.json()) as { result: { streamId: string } };
    expect(ack.result.streamId).toBeTypeOf("string");

    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const collected: string[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && collected.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const e of events) collected.push(e);
    }
    ctrl.abort();

    const methods = collected
      .map((e) => e.replace(/^data:\s*/, ""))
      .map((s) => JSON.parse(s) as { method: string });
    expect(methods.some((m) => m.method === "$/stream/data")).toBe(true);
    expect(methods.some((m) => m.method === "$/stream/end")).toBe(true);
  });

  it("GET / carries channel frames until $/channel/closed", async () => {
    const ctrl = new AbortController();
    const sse = await fetch(`${base}/`, { signal: ctrl.signal });

    expect((await post(base, 10, "openChannel", { channelId: "h1" })).error).toBeUndefined();
    expect((await post(base, 11, "channel.send", { channelId: "h1", message: "x" })).error)
      .toBeUndefined();
    expect((await post(base, 12, "channel.close", { channelId: "h1" })).error).toBeUndefined();
    expect((await post(base, 13, "channel.send", { channelId: "h1", message: "y" })).error?.code)
      .toBe(-32001);

    // Read until the close for this channel arrives: that frame is the
    // signal, so there is no deadline to pick.
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const mine: { method: string; params: { message?: string } }[] = [];
    while (!mine.some((n) => n.method === "$/channel/closed")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const e of events) {
        const n = JSON.parse(e.replace(/^data:\s*/, "")) as {
          method: string;
          params: { channelId?: string; message?: string };
        };
        if (n.params.channelId === "h1") mine.push(n);
      }
    }
    ctrl.abort();

    expect(mine.map((n) => n.method)).toEqual(["$/channel/data", "$/channel/closed"]);
    expect(mine[0]?.params.message).toBe("re:x");
  });

  it("PATCH returns 405", async () => {
    const res = await fetch(`${base}/`, { method: "PATCH" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});
