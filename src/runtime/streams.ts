import type { Notify } from "./channels.js";

// One running `invokeStream`, pumped onto a runtime's notify sink.
export interface StreamPump {
  // Stop pumping: no further `$/stream/data` goes out, and the plugin's
  // iterator is asked to finish so it can release what it holds.
  stop(): void;
  // Resolves once `$/stream/end` is out.
  readonly done: Promise<void>;
}

// Pump `stream` as `$/stream/data` notifications under `streamId`, then send
// `$/stream/end`, however the stream ends.
export function pumpStream(
  streamId: string,
  stream: AsyncIterable<string>,
  notify: Notify,
): StreamPump {
  const iterator = stream[Symbol.asyncIterator]();
  let stopped = false;

  const pump = async (): Promise<void> => {
    try {
      while (!stopped) {
        const next = await iterator.next();
        if (next.done || stopped) break;
        notify({
          jsonrpc: "2.0",
          method: "$/stream/data",
          params: { streamId, message: next.value },
        });
      }
    } finally {
      notify({
        jsonrpc: "2.0",
        method: "$/stream/end",
        params: { streamId },
      });
    }
  };

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      // A generator parked at a `yield` returns at once; one in the middle
      // of an await returns when that settles. Either way no frame follows.
      void Promise.resolve(iterator.return?.()).catch(() => {});
    },
    done: pump(),
  };
}
