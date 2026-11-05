// End-to-end checks of the example plugin against the real Bowire host.
//
//   tsx e2e/host.ts --bowire <bowire executable> --plugin-dir <dir> --work-dir <dir>
//
// The plugin must already be installed into --plugin-dir (the CI job does
// that with `bowire plugin install`). --work-dir is a scratch directory: the
// port file lands there, and it serves as the workspace's storage root, so
// the settings this writes stay out of the operator's ~/.bowire.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  getJson,
  readSse,
  sendJson,
  startWorkbench,
  type SseEvent,
  type Workbench,
} from "./workbench.js";

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      bowire: { type: "string", default: "bowire" },
      "plugin-dir": { type: "string" },
      "work-dir": { type: "string" },
    },
  });
  const pluginDir = values["plugin-dir"];
  const workDir = values["work-dir"];
  if (!pluginDir || !workDir) throw new Error("--plugin-dir and --work-dir are required");

  const storageRoot = join(workDir, "workspace");
  mkdirSync(storageRoot, { recursive: true });

  const workbench = await startWorkbench(values.bowire, pluginDir, workDir);
  try {
    const session = new Session(workbench, storageRoot);
    await checkSettings(session);
    await checkChannels(session);
    await checkManualEntry(workbench);
  } catch (e) {
    console.error(`host log: ${workbench.logFile}`);
    throw e;
  } finally {
    await workbench.stop();
  }
  console.log("e2e: all checks passed");
}

await main();
