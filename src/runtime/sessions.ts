import { ChannelRegistry } from "./channels.js";
import type { Notification } from "./jsonrpc.js";
import type { StreamPump } from "./streams.js";

// The request header a host names itself with over http. Node lower-cases
// header names; on the wire it is `Bowire-Session`.
export const SESSION_HEADER = "bowire-session";

// Where a session's notifications go: one open SSE response.
export interface SessionSink {
  write(payload: string): unknown;
}

// What one host holds on an http sidecar: its SSE streams, its channels and
// its running streams (Kuestenlogik/Bowire#1014).
//
// An http sidecar serves several hosts at once, so "the host left" must end
// that host's things and nobody else's. Everything opened by a request
// belongs to the session that request named, and its notifications go to
// that session's SSE streams only.
//
// Requests without the header come from a host older than the rule. They
// share one unnamed session (`id` undefined), which a `shutdown` does not
// end: there is no telling whose streams it would be ending.
export class Session {
  private readonly sinks = new Set<SessionSink>();
  private readonly streams = new Set<StreamPump>();

  // Send a notification to every SSE stream of this session.
  readonly notify = (n: Notification): void => {
    const payload = `data: ${JSON.stringify(n)}\n\n`;
    for (const sink of this.sinks) {
      try {
        sink.write(payload);
      } catch {
        // dropped: the response's 'close' detaches it
      }
    }
  };

  readonly channels = new ChannelRegistry(this.notify);

  constructor(readonly id: string | undefined) {}

  attach(sink: SessionSink): void {
    this.sinks.add(sink);
  }

  // Returns true when that was the session's last SSE stream: its host is
  // gone, whether or not it said so.
  detach(sink: SessionSink): boolean {
    return this.sinks.delete(sink) && this.sinks.size === 0;
  }

  // Run a stream under this session; it is forgotten once it has ended.
  track(pump: StreamPump): void {
    this.streams.add(pump);
    void pump.done.finally(() => this.streams.delete(pump)).catch(() => {});
  }

  // Nothing left that a later request could refer to.
  get idle(): boolean {
    return this.sinks.size === 0 && this.streams.size === 0 && this.channels.size === 0;
  }

  // The host is leaving: stop its streams and close its channels. The SSE
  // streams stay attached so the closing frames still reach it. Safe to call
  // twice; the second call finds nothing open.
  async end(): Promise<void> {
    for (const pump of this.streams) pump.stop();
    await this.channels.closeAll();
  }
}

// The sessions of one http runtime, by the id their host sent.
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private unnamed: Session | undefined;

  // The session a request belongs to, created on first sight.
  of(id: string | undefined): Session {
    if (id === undefined || id === "") return (this.unnamed ??= new Session(undefined));
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(id);
      this.sessions.set(id, session);
    }
    return session;
  }

  // End a session and forget it.
  async end(session: Session): Promise<void> {
    await session.end();
    this.forgetIfIdle(session);
  }

  // Drop a session that holds nothing, so ids of hosts long gone do not
  // pile up. A later request with the same id starts it afresh.
  forgetIfIdle(session: Session): void {
    if (!session.idle) return;
    if (session.id === undefined) {
      if (this.unnamed === session) this.unnamed = undefined;
    } else if (this.sessions.get(session.id) === session) {
      this.sessions.delete(session.id);
    }
  }

  // The sidecar itself is stopping.
  async endAll(): Promise<void> {
    const all = [...this.sessions.values()];
    if (this.unnamed) all.push(this.unnamed);
    await Promise.allSettled(all.map((s) => s.end()));
    this.sessions.clear();
    this.unnamed = undefined;
  }
}
