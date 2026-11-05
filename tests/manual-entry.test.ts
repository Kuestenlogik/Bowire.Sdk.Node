// The hand-entry form a plugin declares (Kuestenlogik/Bowire#1003): it lands
// in the initialize reply as `manualEntry`, absent when the plugin declares
// none, and a form the host would refuse fails the handshake with the reason.

import { describe, it, expect } from "vitest";
import {
  BowirePluginBase,
  InvokeResult,
  ServiceInfo,
  manualEntryProblems,
  type ManualEntryForm,
} from "../src/index.js";
import { ChannelRegistry } from "../src/runtime/channels.js";
import { dispatch as route } from "../src/runtime/dispatch.js";

const dispatch = (plugin: Parameters<typeof route>[0]) =>
  route(plugin, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, new ChannelRegistry(() => {}));

const kafkaLike: ManualEntryForm = {
  urlPlaceholder: "mybroker://localhost:9000",
  callKinds: [
    { id: "produce", label: "Produce", methodType: "Unary", service: "{topic}", method: "produce" },
    { id: "consume", label: "Consume", methodType: "ServerStreaming", service: "{topic}", method: "consume" },
  ],
  fields: [
    { key: "topic", label: "Topic", placement: "template", required: true },
    { key: "key", label: "Key", callKinds: ["produce"] },
  ],
};

class Plugin extends BowirePluginBase {
  constructor(private readonly form?: ManualEntryForm) {
    super();
  }
  id() { return "mybroker"; }
  name() { return "My broker"; }
  discover(): ServiceInfo[] { return []; }
  invoke(): InvokeResult { return InvokeResult.ok("{}"); }
  manualEntry() { return this.form; }
}

describe("manualEntry in the initialize reply", () => {
  it("carries the form the plugin declares", async () => {
    const result = await dispatch(new Plugin(kafkaLike));
    expect(result.kind).toBe("reply");
    const reply = (result as { response: { result: Record<string, unknown> } }).response.result;
    expect(reply.manualEntry).toEqual(kafkaLike);
  });

  it("is absent when the plugin declares none", async () => {
    const result = await dispatch(new Plugin(undefined));
    const reply = (result as { response: { result: Record<string, unknown> } }).response.result;
    expect("manualEntry" in reply).toBe(false);
  });

  it("fails the handshake for a form the host would refuse, naming why", async () => {
    const broken: ManualEntryForm = {
      callKinds: [{ id: "produce", methodType: "Unary", service: "{topic}" }],
    };
    const result = await dispatch(new Plugin(broken));
    const error = (result as { response: { error?: { message: string } } }).response.error;
    expect(error?.message).toContain("placeholder 'topic'");
  });
});

describe("manualEntryProblems", () => {
  it("finds nothing wrong with a sound form", () => {
    expect(manualEntryProblems(kafkaLike)).toEqual([]);
  });

  it("names each problem the host checks for", () => {
    const problems = manualEntryProblems({
      callKinds: [
        { id: "a", methodType: "Sometimes" as never },
        { id: "a", methodType: "Unary" },
      ],
      fields: [
        { key: "v", type: "select" },
        { key: "w", callKinds: ["b"] },
      ],
    });
    expect(problems).toEqual([
      "call kind 'a' has method type 'Sometimes'",
      "call kind 'a' is declared twice",
      "select field 'v' has no options",
      "field 'w' names unknown call kind 'b'",
    ]);
  });

  it("refuses a form without call kinds", () => {
    expect(manualEntryProblems({ callKinds: [] })).toEqual(["it offers no call kind"]);
  });
});
