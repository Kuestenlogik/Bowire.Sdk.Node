// End-to-end checks of the example plugin against the real Bowire host.
//
//   tsx e2e/host.ts --plugin-dir <dir> --work-dir <dir> [--bowire <exe>]
//   tsx e2e/host.ts --transport http --sidecar <compiled main.js> --plugin-dir <dir> --work-dir <dir>
//
// stdio (the default): the plugin must already be installed into
// --plugin-dir (the CI job does that with `bowire plugin install`), and the
// host spawns it.
//
// http (#17): the sidecar runs on its own. This starts the compiled example
// in HTTP mode on a port the OS picks, installs a sidecar zip whose manifest
// says `"transport": "http"` and that `url`, asks the CLI to discover, runs
// the same checks as over stdio, and at the end stops the sidecar while the
// host is still connected to it.
//
// --work-dir is a scratch directory: the port file and the logs land there,
// and it serves as the workspace's storage root, so the settings this writes
// stay out of the operator's ~/.bowire.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startHttpSidecar, type HttpSidecar } from "./sidecar.js";
import {
  getJson,
  readSse,
  sendJson,
  startWorkbench,
  type SseEvent,
  type Workbench,
} from "./workbench.js";
import { writeZip } from "./zip.js";

const PROTOCOL = "echo";
const SERVICE = "EchoService";

interface ProtocolEntry {
  id: string;
  settings?: { key: string; type?: string; options?: { value: string }[] }[];
}

interface InvokeReply {
  status: string;
  response: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

class Session {
  private readonly query: string;

  constructor(
    private readonly workbench: Workbench,
    storageRoot: string,
  ) {
    this.query = new URLSearchParams({
      workspaceId: "e2e",
      storageRoot,
      serverUrl: `${PROTOCOL}@http://localhost:1`,
    }).toString();
  }

  url(path: string): string {
    return `${this.workbench.url}${path}?${this.query}`;
  }

  async echo(message: string): Promise<string> {
    const reply = await sendJson<InvokeReply>("POST", this.url("/api/invoke"), {
      protocol: PROTOCOL,
      service: SERVICE,
      method: "Echo",
      messages: [message],
    });
    assert(reply.status === "OK", `Echo status OK, got ${reply.status}`);
    return (JSON.parse(reply.response) as { echoed: string }).echoed;
  }

  // A server stream through the workbench's stream endpoint, which runs the
  // host's invokeStream. Over http its frames reach the host as
  // $/stream/data on the sidecar's SSE stream, and $/stream/end is what ends
  // this request.
  async watch(): Promise<{ frames: unknown[]; done: number }> {
    const params = new URLSearchParams({
      protocol: PROTOCOL,
      service: SERVICE,
      method: "Watch",
      messages: JSON.stringify(["{}"]),
    });
    const res = await fetch(`${this.url("/api/invoke/stream")}&${params}`);
    const events: SseEvent[] = [];
    await readSse(res, (e) => events.push(e));
    return {
      frames: events
        .filter((e) => e.event === "message")
        .map((e) => JSON.parse((JSON.parse(e.data) as { data: string }).data) as unknown),
      done: events.filter((e) => e.event === "done").length,
    };
  }

  setSetting(key: string, value: string | null): Promise<unknown> {
    return sendJson("PUT", this.url(`/api/plugins/settings/${PROTOCOL}/${key}`), { value });
  }

  async openChat(): Promise<Chat> {
    const opened = await sendJson<{ channelId: string }>("POST", this.url("/api/channel/open"), {
      protocol: PROTOCOL,
      service: SERVICE,
      method: "Chat",
    });
    return new Chat(this, opened.channelId);
  }
}

// One channel as the workbench drives it: frames in over POST .../send,
// frames out over the SSE stream at .../responses, which ends with a `done`
// event once the sidecar says $/channel/closed.
class Chat {
  readonly events: SseEvent[] = [];
  private ended: Promise<void> | undefined;

  constructor(
    private readonly session: Session,
    readonly id: string,
  ) {}

  // Subscribe to what the plugin sends. The host subscribed to the
  // channel's id before it opened it, so nothing sent before this is lost.
  async listen(): Promise<void> {
    const res = await fetch(this.session.url(`/api/channel/${this.id}/responses`));
    this.ended = readSse(res, (e) => this.events.push(e));
  }

  send(message: string): Promise<Response> {
    return fetch(this.session.url(`/api/channel/${this.id}/send`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
  }

  close(): Promise<unknown> {
    return sendJson("POST", this.session.url(`/api/channel/${this.id}/close`), {});
  }

  // Resolves when the host ends the response stream — the signal that the
  // channel is closed on both sides.
  async done(): Promise<{ echoed: string[]; done: number }> {
    assert(this.ended, "listen() first");
    await this.ended;
    return {
      echoed: this.events
        .filter((e) => e.event === "message")
        .map((e) => (JSON.parse((JSON.parse(e.data) as { data: string }).data) as { echoed: string }).echoed),
      done: this.events.filter((e) => e.event === "done").length,
    };
  }
}

// #693, both halves: the declaration reaches the Settings dialog (with the
// options a select needs), and a value set there reaches the plugin.
async function checkSettings(s: Session): Promise<void> {
  const protocols = await getJson<ProtocolEntry[]>(s.url("/api/protocols"));
  const echo = protocols.find((p) => p.id === PROTOCOL);
  assert(echo, "the echo protocol is listed");
  const transform = echo.settings?.find((x) => x.key === "transform");
  assert(transform?.type === "select", "transform is declared as a select");
  assert(
    transform.options?.map((o) => o.value).join(",") === "none,upper,lower",
    "transform carries its options",
  );
  console.log("settings: declared, with options");

  assert((await s.echo("Hi")) === "Hi", "nothing set: the declared default applies");
  await s.setSetting("transform", "upper");
  assert((await s.echo("Hi")) === "HI", "a set value reaches invoke");
  await s.setSetting("transform", null);
  assert((await s.echo("Hi")) === "Hi", "a cleared value falls back to the default");
  console.log("settings: values reach the plugin per call");
}

// A server-streaming method: Watch streams as many ticks as its `ticks`
// setting says, so this also proves invokeStream receives the values.
async function checkStream(s: Session): Promise<void> {
  const ticks = (r: { frames: unknown[] }) =>
    r.frames.map((f) => (f as { tick: number }).tick).join(",");
  const byDefault = await s.watch();
  assert(ticks(byDefault) === "0,1,2", `three ticks by default: ${ticks(byDefault)}`);
  assert(byDefault.done === 1, "the stream ended once");

  await s.setSetting("ticks", "2");
  try {
    const set = await s.watch();
    assert(ticks(set) === "0,1", `the set value reaches invokeStream: ${ticks(set)}`);
  } finally {
    await s.setSetting("ticks", null);
  }
  console.log("stream: frames in order, ended, settings applied");
}

// Kuestenlogik/Bowire#1003: the hand-entry form the example declares is
// served by the host's ManualEntry service. A host before Bowire 2.11 has no
// such service (404); CI installs the latest released tool, so that is a
// note, not a failure, until 2.11 is out.
async function checkManualEntry(workbench: Workbench): Promise<void> {
  // Not workspace-scoped: the forms describe the loaded plugins.
  const res = await fetch(`${workbench.url}/api/v1/manual-entry-forms?pageSize=200`);
  if (res.status === 404) {
    console.log("manual entry: skipped, this host predates Bowire 2.11");
    return;
  }
  assert(res.ok, `manual-entry forms answer (${res.status})`);
  const body = (await res.json()) as {
    forms: { protocol: string; callKinds: { id: string; methodType: string }[] }[];
  };
  const echo = body.forms.find((f) => f.protocol === PROTOCOL);
  assert(echo, "the echo plugin's form is served");
  assert(
    echo.callKinds.map((k) => `${k.id}:${k.methodType}`).join(",") ===
      "echo:Unary,watch:ServerStreaming,chat:Duplex",
    `the form carries its call kinds: ${echo.callKinds.map((k) => k.id).join(",")}`,
  );
  console.log("manual entry: the declared form is served");
}

// #4: a duplex method end to end, closed once from each side. The setting is
// set first, so this also proves openChannel receives the values.
async function checkChannels(s: Session): Promise<void> {
  await s.setSetting("transform", "upper");
  try {
    const byHost = await s.openChat();
    await byHost.listen();
    for (const text of ["hello", "again"]) {
      const sent = await byHost.send(text);
      assert(sent.ok, `send accepted (${sent.status})`);
      assert(((await sent.json()) as { sent: boolean }).sent, "the sidecar accepted the frame");
    }
    await byHost.close();
    const hostSide = await byHost.done();
    assert(
      hostSide.echoed.join(",") === "HELLO,AGAIN",
      `frames came back in order, transformed: ${hostSide.echoed.join(",")}`,
    );
    assert(hostSide.done === 1, "closed from the host: the stream ended once");
    console.log("channels: open, send both ways, close from the host");

    const byPlugin = await s.openChat();
    await byPlugin.listen();
    await byPlugin.send("ping");
    await byPlugin.send(JSON.stringify({ close: true }));
    const pluginSide = await byPlugin.done();
    assert(pluginSide.echoed.join(",") === "PING", "the frame before the close came back");
    assert(pluginSide.done === 1, "closed from the plugin: the stream ended once");
    const late = await byPlugin.send("anyone?");
    assert(!late.ok, `a send after the plugin closed is refused (${late.status})`);
    console.log("channels: closed from the plugin, a later send refused");
  } finally {
    await s.setSetting("transform", null);
  }
}

function bowireCli(bowire: string, args: string[]): string {
  const run = spawnSync(bowire, args, { encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  console.log(output);
  if (run.error) throw run.error;
  assert(run.status === 0, `bowire ${args.join(" ")} exited ${run.status}`);
  return output;
}

// Starts the example as an http sidecar and installs it the way an operator
// does: a zip with nothing but the manifest, which points at the sidecar.
async function installHttpSidecar(
  bowire: string,
  entry: string,
  pluginDir: string,
  workDir: string,
): Promise<HttpSidecar> {
  const sidecar = await startHttpSidecar(resolve(entry), workDir);
  console.log(`http sidecar at ${sidecar.url}`);
  const stdio = JSON.parse(
    readFileSync(new URL("../examples/echo/sidecar.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const { executable: _e, args: _a, envPrefix: _p, ...rest } = stdio;
  const manifest = {
    ...rest,
    packageId: `${String(stdio.packageId)}.Http`,
    transport: "http",
    url: sidecar.url,
  };
  const zip = join(workDir, "echo-node-http.zip");
  writeZip(zip, { "sidecar.json": JSON.stringify(manifest, null, 2) });
  bowireCli(bowire, ["--plugin-dir", pluginDir, "plugin", "install", "--file", zip]);
  bowireCli(bowire, ["--plugin-dir", pluginDir, "plugin", "list", "--verbose"]);
  const discovered = bowireCli(bowire, [
    "--plugin-dir",
    pluginDir,
    "discover",
    "--url",
    `${PROTOCOL}@http://localhost:1`,
  ]);
  assert(discovered.includes(SERVICE), "the CLI discovers the service over http");
  return sidecar;
}

// The host does not own an http sidecar, so it has to stop when told to,
// while the host still holds its SSE stream open. On Windows a kill is not a
// signal the process can handle, so there the exit is only awaited.
async function stopHttpSidecar(sidecar: HttpSidecar): Promise<void> {
  const exit = await sidecar.stop();
  if (process.platform !== "win32") {
    assert(exit.code === 0, `the sidecar stopped cleanly (${JSON.stringify(exit)})`);
  }
  console.log("http sidecar: stopped with the host still connected");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      bowire: { type: "string", default: "bowire" },
      transport: { type: "string", default: "stdio" },
      sidecar: { type: "string" },
      "plugin-dir": { type: "string" },
      "work-dir": { type: "string" },
    },
  });
  const pluginDir = values["plugin-dir"];
  const workDir = values["work-dir"];
  const transport = values.transport;
  if (!pluginDir || !workDir) throw new Error("--plugin-dir and --work-dir are required");
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`--transport is stdio or http, not ${transport}`);
  }
  if (transport === "http" && !values.sidecar) {
    throw new Error("--transport http needs --sidecar <compiled examples/echo/main.js>");
  }

  const storageRoot = join(workDir, "workspace");
  mkdirSync(storageRoot, { recursive: true });

  const sidecar =
    transport === "http"
      ? await installHttpSidecar(values.bowire, values.sidecar as string, pluginDir, workDir)
      : undefined;
  try {
    const workbench = await startWorkbench(values.bowire, pluginDir, workDir);
    try {
      const session = new Session(workbench, storageRoot);
      await checkSettings(session);
      await checkStream(session);
      await checkChannels(session);
      await checkManualEntry(workbench);
      if (sidecar) await stopHttpSidecar(sidecar);
    } catch (e) {
      console.error(`host log: ${workbench.logFile}`);
      throw e;
    } finally {
      await workbench.stop();
    }
  } catch (e) {
    if (sidecar) console.error(`sidecar log: ${sidecar.logFile}`);
    throw e;
  } finally {
    if (sidecar) await sidecar.stop();
  }
  console.log(`e2e: all ${transport} checks passed`);
}

await main();
