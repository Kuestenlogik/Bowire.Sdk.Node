// Runnable Echo plugin demonstrating the @bowire/plugin surface.
//
// stdio mode (default):
//   tsx examples/echo/main.ts
//
// HTTP/SSE mode (0 lets the OS pick the port; the line printed says which):
//   BOWIRE_HTTP_PORT=8770 tsx examples/echo/main.ts

import {
  BowirePluginBase,
  FieldInfo,
  InvokeResult,
  MessageInfo,
  MethodInfo,
  PluginSetting,
  ServiceInfo,
  run,
  runHttp,
  type ChannelHandle,
  type ManualEntryForm,
  type Metadata,
  type SettingValues,
} from "../../src/index.js";

// Declared once, read on every call. The host renders these in the Echo
// section of the workbench's Settings dialog and sends back only the ones an
// operator changed; `SettingValues` resolves the rest to the defaults here.
const SETTINGS = [
  new PluginSetting("transform", "Transform", "select")
    .withDescription("What Echo does to the text before sending it back")
    .withDefault("none")
    .withOptions([
      { value: "none", label: "As sent" },
      { value: "upper", label: "Upper case" },
      { value: "lower", label: "Lower case" },
    ]),
  new PluginSetting("ticks", "Ticks", "number")
    .withDescription("How many events Watch streams")
    .withDefault(3),
];

// How the three methods are called by hand, without discovery
// (Kuestenlogik/Bowire#1003): the workbench renders a form from this.
const MANUAL_ENTRY: ManualEntryForm = {
  callKinds: [
    { id: "echo", label: "Echo", methodType: "Unary", service: "EchoService", method: "Echo", bodyExample: '{"text":"hello"}' },
    { id: "watch", label: "Watch", methodType: "ServerStreaming", service: "EchoService", method: "Watch" },
    { id: "chat", label: "Chat", methodType: "Duplex", service: "EchoService", method: "Chat", bodyExample: '"hello"' },
  ],
};

function transform(text: string, settings: SettingValues): string {
  switch (settings.string("transform")) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    default:
      return text;
  }
}

class EchoPlugin extends BowirePluginBase {
  override id(): string {
    return "echo";
  }
  override name(): string {
    return "Echo";
  }
  override settings(): PluginSetting[] {
    return SETTINGS;
  }
  manualEntry(): ManualEntryForm {
    return MANUAL_ENTRY;
  }
  override discover(): ServiceInfo[] {
    return [
      new ServiceInfo("EchoService")
        .withDescription("A demo plugin")
        .withMethods([
          MethodInfo.unary("Echo")
            .withInput(
              new MessageInfo("EchoRequest", "echo.EchoRequest").withFields([
                FieldInfo.string("message").makeRequired(),
              ]),
            )
            .withOutput(
              new MessageInfo("EchoResponse", "echo.EchoResponse").withFields([
                FieldInfo.string("echoed"),
              ]),
            )
            .withSummary("Echo a message back"),
          MethodInfo.serverStreaming("Watch").withSummary("Stream tick events"),
          MethodInfo.bidirectional("Chat").withSummary(
            "Echo every frame back; a frame of {\"close\":true} ends the channel",
          ),
        ]),
    ];
  }
  override invoke(
    _serverUrl: string,
    _service: string,
    _method: string,
    jsonMessages: string[],
    _showInternalServices: boolean,
    _metadata: Metadata,
    settings: SettingValues,
  ): InvokeResult {
    const first = jsonMessages[0] ?? "";
    return InvokeResult.ok(JSON.stringify({ echoed: transform(first, settings) }));
  }
  override async *invokeStream(
    _serverUrl: string,
    _service: string,
    _method: string,
    _jsonMessages: string[],
    _metadata: Metadata,
    settings: SettingValues,
  ): AsyncIterable<string> {
    const ticks = settings.number("ticks");
    for (let i = 0; i < ticks; i++) {
      yield JSON.stringify({ tick: i });
    }
  }
  override openChannel(
    _serverUrl: string,
    _service: string,
    _method: string,
    _metadata: Metadata,
    channel: ChannelHandle,
    settings: SettingValues,
  ): void {
    chat(channel, settings);
  }
}

// Duplex: the host opens a channel, then sends frames over it until one side
// closes. The handle is all the plugin keeps — no ids to track, the SDK
// routes the host's frames to the right one.
function chat(channel: ChannelHandle, settings: SettingValues): void {
  channel.onMessage(async (message) => {
    if (wantsClose(message)) {
      await channel.close();
      return;
    }
    channel.send(JSON.stringify({ echoed: transform(message, settings) }));
  });
}

function wantsClose(message: string): boolean {
  try {
    return (JSON.parse(message) as { close?: unknown }).close === true;
  } catch {
    return false;
  }
}

const httpPort = process.env.BOWIRE_HTTP_PORT;
if (httpPort) {
  // An http sidecar runs on its own; the host connects to it and never stops
  // it. Port 0 lets the OS pick one, and the line below says which: it is
  // printed once the sidecar accepts connections.
  const handle = await runHttp(new EchoPlugin(), "127.0.0.1", Number(httpPort));
  process.stderr.write(`echo listening on http://127.0.0.1:${handle.port}/\n`);
  // Told to stop, end the SSE streams hosts hold open and exit cleanly.
  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else {
  await run(new EchoPlugin());
}
