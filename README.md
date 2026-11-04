# @bowire/plugin

Node.js SDK for authoring [Bowire](https://bowire.io) sidecar plugins.

Bowire hosts protocol plugins as .NET assemblies by default. The
sidecar bridge widens that surface — any language that speaks
JSON-RPC over stdin/stdout (or HTTP/SSE) can ship a Bowire plugin.
This package is the Node.js side of that bridge.

## Install

```bash
npm install @bowire/plugin
```

Requires Node.js 22.12 or newer (uses `node:crypto.randomUUID` and the
global `fetch`-style streaming primitives). Node 20 was supported until
it went end-of-maintenance on 2026-04-30.

## Author a plugin

```ts
import {
  BowirePluginBase,
  InvokeResult,
  MethodInfo,
  ServiceInfo,
  run,
  type Metadata,
} from "@bowire/plugin";

class EchoPlugin extends BowirePluginBase {
  id() { return "echo"; }
  name() { return "Echo"; }

  discover() {
    return [
      new ServiceInfo("EchoService").withMethods([
        MethodInfo.unary("Echo"),
      ]),
    ];
  }

  invoke(
    _endpoint: string,
    _service: string,
    _method: string,
    body: string[],
    _streaming: boolean,
    _metadata: Metadata,
  ): InvokeResult {
    return InvokeResult.ok(JSON.stringify({ echoed: body[0] ?? "" }));
  }
}

await run(new EchoPlugin());
```

`BowirePluginBase` requires `id`, `name`, `discover`, and `invoke`;
`invokeStream`, `settings`, and `shutdown` ship with no-op defaults.
`openChannel` has none: implement it to serve duplex methods (see
[Channels](#channels)). Override only what you need.

## Settings

A setting has two halves: the plugin declares it, and the host sends its
value back with every call.

**Declare** it in `settings()`. The host renders each entry in the
plugin's section of the workbench's Settings dialog. `type` is `"bool"`,
`"string"`, `"number"` or `"select"`; a `select` needs `options`.

```ts
import { PluginSetting } from "@bowire/plugin";

settings() {
  return [
    new PluginSetting("probeWindow", "Probe window", "number").withDefault(5),
    new PluginSetting("mode", "Mode", "select")
      .withDefault("fast")
      .withOptions([
        { value: "fast", label: "Fast" },
        { value: "safe", label: "Safe" },
      ]),
  ];
}
```

**Read** it from the `settings` argument — the last parameter of
`discover`, `invoke`, `invokeStream` and `openChannel`:

```ts
invoke(serverUrl, service, method, jsonMessages, showInternalServices,
       metadata, settings: SettingValues) {
  const window = settings.number("probeWindow"); // 5 until someone sets it
  const mode = settings.string("mode");
  // ...
}
```

The values arrive fresh with each call, so a changed setting takes effect
without restarting the sidecar. On the wire every value is a string, and
only keys someone actually set travel. `SettingValues` handles both:

- `string(key)`, `bool(key)`, `number(key)` parse the text into the
  requested type, and fall back to the declared `defaultValue` when the
  key is absent or does not parse. `bool` reads `true` / `false` (any
  case) and `1` / `0`.
- An optional second argument is the fallback for a setting declared
  without a default. With neither, the accessor throws — that is a bug in
  the plugin, not in the operator's input.
- `has(key)` and `raw(key)` tell whether the host sent a value and what
  text it was.

Env vars are not the channel for settings: `envPrefix` forwards the
host's environment once, at spawn.

## Channels

A duplex method (`MethodInfo.bidirectional`) is served by `openChannel`.
The host opens the channel, sends frames over it, and either side closes
it. The plugin gets a `ChannelHandle`:

```ts
openChannel(serverUrl, service, method, metadata, channel: ChannelHandle,
            settings: SettingValues) {
  channel.onMessage(async (message) => {
    if (message === '"bye"') return channel.close();
    channel.send(JSON.stringify({ echoed: message }));
  });
  channel.onClose(() => {
    // release whatever the channel holds
  });
}
```

- `onMessage` handlers get every frame the host sends, in order. Register
  them inside `openChannel`; the host sends nothing before the open is
  answered. A handler that throws makes that send fail on the host side.
- `send` pushes a frame to the host. It returns `false` once the channel
  is closed.
- `close` ends the channel from the plugin's side. A close from the host
  ends it the same way.
- `onClose` handlers run exactly once, whichever side closed, before the
  host is told — they may still `send` a last frame.
- `channel.id` is the id the host minted. Several channels can be open
  at once; each handle only ever sees its own frames.
- `shutdown`, and a host that goes away (stdin closes), close every open
  channel.

`initialize` reports `capabilities.channels: true` only for a plugin that
implements `openChannel`, so the host does not offer a channel the plugin
cannot serve.

Handlers run on the dispatch loop: a handler that waits for a later frame
on the same channel waits forever. Keep them to reacting to the frame they
got.

## Transports

Pick the wire your sidecar runs over. Both routes go through the
same internal `dispatch`, so contract semantics live in one place
regardless of how the wire is framed.

### stdio (default — `run`)

```ts
import { run } from "@bowire/plugin";
await run(new MyPlugin());
```

NDJSON JSON-RPC on stdin/stdout, zero deps. The Bowire host spawns
the sidecar binary and pipes both wires. This is the recommended
default for local / single-tenant setups.

### HTTP/SSE (`runHttp`)

```ts
import { runHttp } from "@bowire/plugin";
const handle = await runHttp(new MyPlugin(), "127.0.0.1", 8770);
console.log(`listening on port ${handle.port}`);
// await handle.close() to stop.
```

Streamable-HTTP variant — `POST /` lands JSON-RPC requests, `GET /`
is a long-lived SSE stream the runtime pushes server notifications
onto (`$/stream/data`, `$/stream/end`, `$/channel/data`,
`$/channel/closed`). Fits hosted /
multi-tenant deployments where one sidecar serves many workbenches.

## Wire model

Service / method / message / field shapes are emitted as camelCase
on the wire — matching what the Python and Rust SDKs serialise.

```ts
import { ServiceInfo, MethodInfo, MessageInfo, FieldInfo } from "@bowire/plugin";

const svc = new ServiceInfo("Demo")
  .withMethods([
    MethodInfo.serverStreaming("Watch")
      .withInput(new MessageInfo("WatchReq", "demo.WatchReq").withFields([
        FieldInfo.string("topic").makeRequired(),
      ]))
      .withSummary("Watch a topic"),
  ]);
```

## Breaking changes

Pre-1.0, changes land in one cut. Since 0.2.0:

- `ChannelHandle` is now what the host routes to: `send` returns a
  boolean, and `id`, `closed` and `close()` are new.
- `BowirePluginBase` no longer ships a no-op `openChannel`. The no-op
  would have made `capabilities.channels` claim duplex support for every
  plugin. Implement it, or leave it out.
- `dispatch(plugin, request, channels)` takes the runtime's
  `ChannelRegistry` as a third argument. Only code that drives `dispatch`
  directly, rather than through `run` / `runHttp`, is affected.
- Every plugin call gains a trailing `settings: SettingValues` argument.
  Existing implementations that leave it off still compile.

## Related

- [Bowire (host)](https://github.com/Kuestenlogik/Bowire)
- [Bowire.Sdk.Python](https://github.com/Kuestenlogik/Bowire.Sdk.Python) — Python sibling
- [Bowire.Sdk.Rust](https://github.com/Kuestenlogik/Bowire.Sdk.Rust) — Rust sibling

## License

MIT
