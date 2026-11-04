// The per-call settings values (#693): what the host sends, what an absent
// key resolves to, and how a string becomes what the setting declared. The
// dispatcher half — that discover / invoke / invokeStream hand the values to
// the plugin — is covered at the bottom against `dispatch` itself.

import { describe, it, expect } from "vitest";
import {
  BowirePluginBase,
  InvokeResult,
  PluginSetting,
  ServiceInfo,
  SettingValues,
  type Metadata,
} from "../src/index.js";
import { dispatch } from "../src/runtime/dispatch.js";

const declared = [
  new PluginSetting("probeWindow", "Probe window", "number").withDefault(5),
  new PluginSetting("verbose", "Verbose", "bool").withDefault(false),
  new PluginSetting("mode", "Mode", "select")
    .withDefault("fast")
    .withOptions([{ value: "fast" }, { value: "safe", label: "Safe" }]),
  new PluginSetting("token", "Token", "string"),
];

describe("SettingValues", () => {
  it("parses present values into what the setting declared", () => {
    const s = SettingValues.fromWire(
      { probeWindow: "7", verbose: "true", mode: "safe", token: "abc" },
      declared,
    );
    expect(s.number("probeWindow")).toBe(7);
    expect(s.bool("verbose")).toBe(true);
    expect(s.string("mode")).toBe("safe");
    expect(s.string("token")).toBe("abc");
  });

  it("falls back to the declared default when a key is absent", () => {
    // Only keys that are actually set travel; an absent key means "yours".
    const s = SettingValues.fromWire({}, declared);
    expect(s.has("probeWindow")).toBe(false);
    expect(s.number("probeWindow")).toBe(5);
    expect(s.bool("verbose")).toBe(false);
    expect(s.string("mode")).toBe("fast");
  });

  it("treats a missing settings field like nothing set", () => {
    const s = SettingValues.fromWire(undefined, declared);
    expect(s.keys()).toEqual([]);
    expect(s.number("probeWindow")).toBe(5);
  });

  it("uses the fallback only when nothing was declared", () => {
    const s = SettingValues.fromWire({}, declared);
    expect(s.string("token", "none")).toBe("none");
    expect(s.number("probeWindow", 99)).toBe(5);
  });

  it("throws for a setting with no value, default or fallback", () => {
    const s = SettingValues.fromWire({}, declared);
    expect(() => s.string("token")).toThrow(/token/);
  });

  it("parses bool spellings and refuses anything else", () => {
    const parse = (v: string) => SettingValues.fromWire({ verbose: v }, declared).bool("verbose");
    expect(parse("TRUE")).toBe(true);
    expect(parse(" 1 ")).toBe(true);
    expect(parse("False")).toBe(false);
    expect(parse("0")).toBe(false);
    // Unparseable reads as absent: the declared default applies.
    expect(parse("yes please")).toBe(false);
  });

  it("parses numbers and refuses what is not a finite one", () => {
    const parse = (v: string) =>
      SettingValues.fromWire({ probeWindow: v }, declared).number("probeWindow");
    expect(parse("2.5")).toBe(2.5);
    expect(parse(" -3 ")).toBe(-3);
    expect(parse("")).toBe(5);
    expect(parse("abc")).toBe(5);
    expect(parse("Infinity")).toBe(5);
  });

  it("keeps the raw text and accepts primitive values from the wire", () => {
    const s = SettingValues.fromWire({ probeWindow: 7, verbose: true, junk: {} }, declared);
    expect(s.raw("probeWindow")).toBe("7");
    expect(s.bool("verbose")).toBe(true);
    expect(s.has("junk")).toBe(false);
    expect(s.raw("mode")).toBeUndefined();
  });

  it("coerces a declared default given as text", () => {
    const s = SettingValues.fromWire({}, [
      new PluginSetting("n", "N", "number").withDefault("12"),
      new PluginSetting("b", "B", "bool").withDefault("true"),
    ]);
    expect(s.number("n")).toBe(12);
    expect(s.bool("b")).toBe(true);
  });
});

class SettingsPlugin extends BowirePluginBase {
  readonly seen: SettingValues[] = [];
  override id(): string {
    return "settings";
  }
  override name(): string {
    return "Settings";
  }
  override settings(): PluginSetting[] {
    return declared;
  }
  override discover(
    _serverUrl: string,
    _showInternalServices: boolean,
    settings: SettingValues,
  ): ServiceInfo[] {
    this.seen.push(settings);
    return [];
  }
  override invoke(
    _serverUrl: string,
    _service: string,
    _method: string,
    _jsonMessages: string[],
    _showInternalServices: boolean,
    _metadata: Metadata,
    settings: SettingValues,
  ): InvokeResult {
    return InvokeResult.ok(JSON.stringify({ probeWindow: settings.number("probeWindow") }));
  }
  override async *invokeStream(
    _serverUrl: string,
    _service: string,
    _method: string,
    _jsonMessages: string[],
    _metadata: Metadata,
    settings: SettingValues,
  ): AsyncIterable<string> {
    yield settings.string("mode");
  }
}

describe("dispatch hands settings to the plugin", () => {
  it("initialize sends options for a select setting", async () => {
    const r = await dispatch(new SettingsPlugin(), { jsonrpc: "2.0", id: 1, method: "initialize" });
    if (r.kind !== "reply") throw new Error();
    const result = JSON.parse(JSON.stringify(r.response.result)) as {
      settings: { key: string; options?: unknown }[];
    };
    const mode = result.settings.find((s) => s.key === "mode");
    expect(mode?.options).toEqual([{ value: "fast" }, { value: "safe", label: "Safe" }]);
    expect(result.settings.find((s) => s.key === "token")?.options).toBeUndefined();
  });

  it("discover receives the values the host sent", async () => {
    const p = new SettingsPlugin();
    await dispatch(
      p,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "discover",
        params: { serverUrl: "x://", settings: { probeWindow: "9" } },
      },
    );
    expect(p.seen[0]?.number("probeWindow")).toBe(9);
  });

  it("invoke reads a present value and the default for an absent one", async () => {
    const invoke = async (settings?: Record<string, string>) => {
      const r = await dispatch(
        new SettingsPlugin(),
        { jsonrpc: "2.0", id: 1, method: "invoke", params: { method: "M", jsonMessages: [], settings } },
      );
      if (r.kind !== "reply") throw new Error();
      return (r.response.result as InvokeResult).response;
    };
    expect(await invoke({ probeWindow: "7" })).toBe('{"probeWindow":7}');
    expect(await invoke()).toBe('{"probeWindow":5}');
  });

  it("invokeStream receives the values the host sent", async () => {
    const r = await dispatch(
      new SettingsPlugin(),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "invokeStream",
        params: { streamId: "s1", settings: { mode: "safe" } },
      },
    );
    if (r.kind !== "stream") throw new Error();
    const frames: string[] = [];
    for await (const f of r.stream) frames.push(f);
    expect(frames).toEqual(["safe"]);
  });
});
