// Public surface of @bowire/plugin.

export {
  FieldInfo,
  InvokeResult,
  MessageInfo,
  MethodInfo,
  PluginSetting,
  ServiceInfo,
  type MethodType,
  type SettingOption,
} from "./models.js";

export { SettingValues } from "./settings.js";

export {
  manualEntryProblems,
  type ManualCallKind,
  type ManualEntryForm,
  type ManualField,
  type ManualMethodType,
} from "./manual-entry.js";

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
  ChannelRegistry,
  HostChannel,
  ERR_CHANNEL_CLOSED,
  SIDECAR_PROTOCOL_VERSION,
  type DispatchResult,
  type HttpRuntimeHandle,
  type Notify,
  type Notification,
  type Request,
  type Response,
  type ErrorObject,
} from "./runtime/index.js";
