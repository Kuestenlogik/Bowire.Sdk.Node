// Runnable Echo plugin demonstrating the @bowire/plugin surface.
//
// stdio mode (default):
//   tsx examples/echo/main.ts
//
// HTTP/SSE mode:
//   BOWIRE_HTTP_PORT=8770 tsx examples/echo/main.ts

import {
  BowirePluginBase,
  FieldInfo,
  InvokeResult,
  MessageInfo,
  MethodInfo,
  ServiceInfo,
  run,
  runHttp,
  type Metadata,
} from "../../src/index.js";

class EchoPlugin extends BowirePluginBase {
  override id(): string {
    return "echo";
  }
  override name(): string {
    return "Echo";
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
        ]),
    ];
  }
  override invoke(
    _endpoint: string,
    _service: string,
    _method: string,
    body: string[],
    _streaming: boolean,
    _metadata: Metadata,
  ): InvokeResult {
    const first = body[0] ?? "";
    return InvokeResult.ok(JSON.stringify({ echoed: first }));
  }
  override async *invokeStream(
    _endpoint: string,
    _service: string,
    _method: string,
    _body: string[],
    _metadata: Metadata,
  ): AsyncIterable<string> {
    for (let i = 0; i < 3; i++) {
      yield JSON.stringify({ tick: i });
    }
  }
}

const httpPort = process.env.BOWIRE_HTTP_PORT;
if (httpPort) {
  const handle = await runHttp(new EchoPlugin(), "127.0.0.1", Number(httpPort));
  process.stderr.write(`echo listening on http://127.0.0.1:${handle.port}\n`);
} else {
  await run(new EchoPlugin());
}
