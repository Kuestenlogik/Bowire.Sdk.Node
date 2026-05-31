// End-to-end exercises of the shared dispatcher. Both runtimes
// (stdio + http) route every inbound request through `dispatch`,
// so coverage here proves the contract semantics regardless of
// transport.

import { describe, it, expect } from "vitest";
import {
  BowirePluginBase,
  InvokeResult,
  ServiceInfo,
  MethodInfo,
  type Metadata,
} from "../src/index.js";
import { dispatch } from "../src/runtime/dispatch.js";

class TestPlugin extends BowirePluginBase {
  shutdownCalled = false;
  override id(): string {
    return "test";
  }
  override name(): string {
    return "Test Plugin";
  }
  override discover(): ServiceInfo[] {
    return [new ServiceInfo("Svc").withMethods([MethodInfo.unary("M")])];
  }
  override invoke(
    _endpoint: string,
    _service: string,
    method: string,
    body: string[],
    _streaming: boolean,
    _metadata: Metadata,
  ): InvokeResult {
    if (method === "fail") throw new Error("boom");
    return InvokeResult.ok(JSON.stringify({ echoed: body[0] ?? "" }));
  }
  override async *invokeStream(
    _endpoint: string,
    _service: string,
    _method: string,
    _body: string[],
    _metadata: Metadata,
  ): AsyncIterable<string> {
    yield "frame-1";
    yield "frame-2";
  }
  override async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }
}

describe("dispatch", () => {
  it("initialize returns id+name+settings", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(r.kind).toBe("reply");
    if (r.kind !== "reply") throw new Error();
    const result = r.response.result as { id: string; name: string; settings: unknown[] };
    expect(result.id).toBe("test");
    expect(result.name).toBe("Test Plugin");
    expect(result.settings).toEqual([]);
  });

  it("ping returns pong:true", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    if (r.kind !== "reply") throw new Error();
    expect(r.response.result).toEqual({ pong: true });
  });

  it("discover returns wrapped service list", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "discover",
      params: { endpoint: "x", refresh: false },
    });
    if (r.kind !== "reply") throw new Error();
    const result = r.response.result as { services: unknown[] };
    expect(result.services).toHaveLength(1);
  });

  it("invoke echoes body through InvokeResult.ok", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "invoke",
      params: {
        endpoint: "x",
        service: "Svc",
        method: "M",
        body: ["hi"],
        streaming: false,
        metadata: {},
      },
    });
    if (r.kind !== "reply") throw new Error();
    const result = r.response.result as InvokeResult;
    expect(result.status).toBe("OK");
    expect(result.response).toBe('{"echoed":"hi"}');
  });

  it("invoke errors surface as error response with internal code", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "invoke",
      params: { method: "fail", body: [] },
    });
    if (r.kind !== "reply") throw new Error();
    expect(r.response.error?.code).toBe(-32603);
    expect(r.response.error?.message).toBe("boom");
  });

  it("invokeStream produces ack + iterable", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "invokeStream",
      params: { method: "M", body: [] },
    });
    expect(r.kind).toBe("stream");
    if (r.kind !== "stream") throw new Error();
    expect(r.streamId).toBeTypeOf("string");
    const ack = r.ack.result as { streamId: string };
    expect(ack.streamId).toBe(r.streamId);
    const frames: string[] = [];
    for await (const f of r.stream) frames.push(f);
    expect(frames).toEqual(["frame-1", "frame-2"]);
  });

  it("shutdown calls plugin.shutdown and returns shutdown kind", async () => {
    const p = new TestPlugin();
    const r = await dispatch(p, {
      jsonrpc: "2.0",
      id: 1,
      method: "shutdown",
    });
    expect(r.kind).toBe("shutdown");
    expect(p.shutdownCalled).toBe(true);
  });

  it("unknown method returns method-not-found", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "wat",
    });
    if (r.kind !== "reply") throw new Error();
    expect(r.response.error?.code).toBe(-32601);
  });
});
