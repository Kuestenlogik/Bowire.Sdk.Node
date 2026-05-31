// Verifies the camelCase wire shape against what the Bowire host
// expects on the JSON-RPC envelope (cross-checked with Python+Rust).

import { describe, it, expect } from "vitest";
import {
  FieldInfo,
  InvokeResult,
  MessageInfo,
  MethodInfo,
  PluginSetting,
  ServiceInfo,
} from "../src/models.js";

describe("ServiceInfo", () => {
  it("serialises camelCase with method array", () => {
    const svc = new ServiceInfo("DemoService")
      .withMethods([MethodInfo.unary("Echo")])
      .withDescription("A demo service");

    const json = JSON.parse(JSON.stringify(svc));
    expect(json.name).toBe("DemoService");
    expect(json.description).toBe("A demo service");
    expect(json.methods[0].name).toBe("Echo");
    expect(json.methods[0].methodType).toBe("Unary");
  });

  it("omits description when not set", () => {
    const json = JSON.parse(JSON.stringify(new ServiceInfo("S")));
    expect("description" in json).toBe(false);
  });
});

describe("MethodInfo", () => {
  it("unary is not streaming", () => {
    const m = MethodInfo.unary("Get");
    expect(m.clientStreaming).toBe(false);
    expect(m.serverStreaming).toBe(false);
    expect(m.methodType).toBe("Unary");
  });

  it("server-streaming sets flag and marker", () => {
    const m = MethodInfo.serverStreaming("Watch");
    expect(m.clientStreaming).toBe(false);
    expect(m.serverStreaming).toBe(true);
    expect(m.methodType).toBe("ServerStreaming");
  });

  it("bidirectional flips both flags", () => {
    const m = MethodInfo.bidirectional("Chat");
    expect(m.clientStreaming).toBe(true);
    expect(m.serverStreaming).toBe(true);
  });

  it("chains input/output/summary", () => {
    const m = MethodInfo.unary("Echo")
      .withInput(new MessageInfo("Req", "echo.Req"))
      .withOutput(new MessageInfo("Resp", "echo.Resp"))
      .withSummary("Echo back");
    expect(m.inputType).toBeDefined();
    expect(m.outputType).toBeDefined();
    expect(m.summary).toBe("Echo back");
  });

  it("omits unset optional fields from serialisation", () => {
    const json = JSON.parse(JSON.stringify(MethodInfo.unary("X")));
    expect("inputType" in json).toBe(false);
    expect("outputType" in json).toBe(false);
    expect("httpMethod" in json).toBe(false);
  });
});

describe("FieldInfo", () => {
  it("builders pick the expected type names", () => {
    expect(FieldInfo.string("a").typeName).toBe("string");
    expect(FieldInfo.int32("b").typeName).toBe("int32");
    expect(FieldInfo.bool("c").typeName).toBe("bool");
    expect(FieldInfo.string("a").makeRequired().required).toBe(true);
  });
});

describe("MessageInfo", () => {
  it("withFields extends field list", () => {
    const m = new MessageInfo("M", "ns.M").withFields([
      FieldInfo.string("name").makeRequired(),
      FieldInfo.int32("count"),
    ]);
    expect(m.fields).toHaveLength(2);
    expect(m.fields[0]!.required).toBe(true);
    expect(m.fields[1]!.required).toBe(false);
  });
});

describe("InvokeResult", () => {
  it("ok sets status and response", () => {
    const r = InvokeResult.ok('{"echoed":true}');
    expect(r.status).toBe("OK");
    expect(r.response).toBe('{"echoed":true}');
  });

  it("err supports optional response body", () => {
    const withMsg = InvokeResult.err("Error", "nope");
    expect(withMsg.status).toBe("Error");
    expect(withMsg.response).toBe("nope");

    const without = InvokeResult.err("Error");
    expect(without.response).toBeUndefined();
  });

  it("serialises camelCase with metadata + durationMs", () => {
    const json = JSON.parse(JSON.stringify(InvokeResult.ok("{}")));
    expect("durationMs" in json).toBe(true);
    expect("metadata" in json).toBe(true);
  });
});

describe("PluginSetting", () => {
  it("default value and required flag round-trip", () => {
    const s = new PluginSetting("host", "Host", "string")
      .withDefault("localhost")
      .makeRequired();
    const json = JSON.parse(JSON.stringify(s));
    expect(json.key).toBe("host");
    expect(json.defaultValue).toBe("localhost");
    expect(json.required).toBe(true);
  });
});
