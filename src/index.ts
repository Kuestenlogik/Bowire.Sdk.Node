// Public surface of @bowire/plugin.

export {
  FieldInfo,
  InvokeResult,
  MessageInfo,
  MethodInfo,
  PluginSetting,
  ServiceInfo,
  type MethodType,
} from "./models.js";

export {
  BowirePluginBase,
  type BowirePlugin,
  type ChannelHandle,
  type InvokeStreamChunk,
  type Metadata,
} from "./plugin.js";

export {
  run,
  runHttp,
  dispatch,
  type DispatchResult,
  type HttpRuntimeHandle,
  type Notification,
  type Request,
  type Response,
  type ErrorObject,
} from "./runtime/index.js";
