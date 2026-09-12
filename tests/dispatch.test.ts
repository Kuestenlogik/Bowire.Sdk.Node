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
  SIDECAR_PROTOCOL_VERSION,
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
  override iconSvg(): string {
    return "<svg/>";
  }
  override invoke(
    _serverUrl: string,
    _service: string,
    method: string,
    jsonMessages: string[],
    _showInternalServices: boolean,
    _metadata: Metadata,
  ): InvokeResult {
    if (method === "fail") throw new Error("boom");
    return InvokeResult.ok(JSON.stringify({ echoed: jsonMessages[0] ?? "" }));
  }
  override async *invokeStream(
    _serverUrl: string,
    _service: string,
    _method: string,
    _jsonMessages: string[],
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
  it("initialize returns id+name+iconSvg+settings", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(r.kind).toBe("reply");
    if (r.kind !== "reply") throw new Error();
    const result = r.response.result as {
      id: string;
      name: string;
      iconSvg: string;
      settings: unknown[];
    };
    expect(result.id).toBe("test");
    expect(result.name).toBe("Test Plugin");
    expect(result.iconSvg).toBe("<svg/>");
    expect(result.settings).toEqual([]);
  });

  it("initialize advertises the contract version and capabilities", async () => {
    // #416. Without these the host logs "treating it as legacy sidecar
    // contract v1" on every boot and cannot refuse an incompatible sidecar
    // at the handshake. `channels` is false because this dispatcher has no
    // openChannel case — saying true would earn a method-not-found per
    // duplex method an operator opens.
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    if (r.kind !== "reply") throw new Error();
    const result = r.response.result as {
      protocolVersion: number;
      capabilities: Record<string, boolean>;
    };
    expect(result.protocolVersion).toBe(SIDECAR_PROTOCOL_VERSION);
    expect(result.capabilities).toEqual({
      discover: true,
      invoke: true,
      invokeStream: true,
      channels: false,
    });
  });

  it("ping returns the bare pong string the contract asks for", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    if (r.kind !== "reply") throw new Error();
    expect(r.response.result).toBe("pong");
  });

  it("discover reads serverUrl and returns a bare array", async () => {
    // The host sends `serverUrl` / `showInternalServices` and reads anything
    // but an array as "no services, try the next plugin" — so the old
    // `{endpoint, refresh}` + `{services: [...]}` shape discovered nothing,
    // quietly, every time.
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "discover",
      params: { serverUrl: "x://host", showInternalServices: false },
    });
    if (r.kind !== "reply") throw new Error();
    expect(Array.isArray(r.response.result)).toBe(true);
    expect(r.response.result as unknown[]).toHaveLength(1);
  });

  it("invoke echoes body through InvokeResult.ok", async () => {
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "invoke",
      params: {
        serverUrl: "x://host",
        service: "Svc",
        method: "M",
        jsonMessages: ["hi"],
        showInternalServices: false,
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
      params: { method: "fail", jsonMessages: [] },
    });
    if (r.kind !== "reply") throw new Error();
    expect(r.response.error?.code).toBe(-32603);
    expect(r.response.error?.message).toBe("boom");
  });

  it("invokeStream keeps the host's streamId", async () => {
    // The host mints the id and subscribes to it before sending the request.
    // A self-minted one publishes every frame into a channel nobody reads,
    // which is how streaming looked "empty" rather than broken.
    const r = await dispatch(new TestPlugin(), {
      jsonrpc: "2.0",
      id: 1,
      method: "invokeStream",
      params: { streamId: "host-minted-42", method: "M", jsonMessages: [] },
    });
    expect(r.kind).toBe("stream");
    if (r.kind !== "stream") throw new Error();
    expect(r.streamId).toBe("host-minted-42");
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
