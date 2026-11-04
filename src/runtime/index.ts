export { run } from "./stdio.js";
export { runHttp, type HttpRuntimeHandle } from "./http.js";
export { ChannelRegistry, HostChannel, type Notify } from "./channels.js";
export { ERR_CHANNEL_CLOSED } from "./jsonrpc.js";
export {
  dispatch,
  SIDECAR_PROTOCOL_VERSION,
  type DispatchResult,
} from "./dispatch.js";
export type { Request, Response, Notification, ErrorObject } from "./jsonrpc.js";
