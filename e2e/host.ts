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
import { getJson, sendJson, startWorkbench, type Workbench } from "./workbench.js";

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
  } catch (e) {
    console.error(`host log: ${workbench.logFile}`);
    throw e;
  } finally {
    await workbench.stop();
  }
  console.log("e2e: all checks passed");
}

await main();
