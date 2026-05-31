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

Requires Node.js 20 or newer (uses `node:crypto.randomUUID` and the
global `fetch`-style streaming primitives).

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
`invokeStream`, `openChannel`, `settings`, and `shutdown` ship with
no-op defaults. Override only what you need.

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
onto (`$/stream/data`, `$/stream/end`). Fits hosted /
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

## Related

- [Bowire (host)](https://github.com/Kuestenlogik/Bowire)
- [Bowire.Sdk.Python](https://github.com/Kuestenlogik/Bowire.Sdk.Python) — Python sibling
- [Bowire.Sdk.Rust](https://github.com/Kuestenlogik/Bowire.Sdk.Rust) — Rust sibling

## License

MIT
