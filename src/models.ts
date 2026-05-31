// Wire-side data models for the Bowire JSON-RPC plugin contract.
// The shapes are camelCase on the wire — matches what the Python SDK
// and Rust SDK serialise. JSON.stringify on these classes produces
// the expected envelope directly via toJSON().

export type MethodType =
  | "Unary"
  | "ServerStreaming"
  | "ClientStreaming"
  | "Bidirectional";

export class FieldInfo {
  name: string;
  typeName: string;
  required: boolean;
  description?: string;

  constructor(name: string, typeName: string) {
    this.name = name;
    this.typeName = typeName;
    this.required = false;
  }

  static string(name: string): FieldInfo {
    return new FieldInfo(name, "string");
  }
  static int32(name: string): FieldInfo {
    return new FieldInfo(name, "int32");
  }
  static int64(name: string): FieldInfo {
    return new FieldInfo(name, "int64");
  }
  static bool(name: string): FieldInfo {
    return new FieldInfo(name, "bool");
  }
  static double(name: string): FieldInfo {
    return new FieldInfo(name, "double");
  }

  makeRequired(): this {
    this.required = true;
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      typeName: this.typeName,
      required: this.required,
    };
    if (this.description !== undefined) out.description = this.description;
    return out;
  }
}

export class MessageInfo {
  name: string;
  fullName: string;
  fields: FieldInfo[] = [];
  description?: string;

  constructor(name: string, fullName: string) {
    this.name = name;
    this.fullName = fullName;
  }

  withFields(fields: Iterable<FieldInfo>): this {
    for (const f of fields) this.fields.push(f);
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      fullName: this.fullName,
      fields: this.fields,
    };
    if (this.description !== undefined) out.description = this.description;
    return out;
  }
}

export class MethodInfo {
  name: string;
  methodType: MethodType;
  clientStreaming: boolean;
  serverStreaming: boolean;
  inputType?: MessageInfo;
  outputType?: MessageInfo;
  summary?: string;
  httpMethod?: string;
  httpPath?: string;

  private constructor(name: string, methodType: MethodType) {
    this.name = name;
    this.methodType = methodType;
    this.clientStreaming =
      methodType === "ClientStreaming" || methodType === "Bidirectional";
    this.serverStreaming =
      methodType === "ServerStreaming" || methodType === "Bidirectional";
  }

  static unary(name: string): MethodInfo {
    return new MethodInfo(name, "Unary");
  }
  static serverStreaming(name: string): MethodInfo {
    return new MethodInfo(name, "ServerStreaming");
  }
  static clientStreaming(name: string): MethodInfo {
    return new MethodInfo(name, "ClientStreaming");
  }
  static bidirectional(name: string): MethodInfo {
    return new MethodInfo(name, "Bidirectional");
  }

  withInput(input: MessageInfo): this {
    this.inputType = input;
    return this;
  }
  withOutput(output: MessageInfo): this {
    this.outputType = output;
    return this;
  }
  withSummary(summary: string): this {
    this.summary = summary;
    return this;
  }
  withHttp(method: string, path: string): this {
    this.httpMethod = method;
    this.httpPath = path;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      methodType: this.methodType,
      clientStreaming: this.clientStreaming,
      serverStreaming: this.serverStreaming,
    };
    if (this.inputType !== undefined) out.inputType = this.inputType;
    if (this.outputType !== undefined) out.outputType = this.outputType;
    if (this.summary !== undefined) out.summary = this.summary;
    if (this.httpMethod !== undefined) out.httpMethod = this.httpMethod;
    if (this.httpPath !== undefined) out.httpPath = this.httpPath;
    return out;
  }
}

export class ServiceInfo {
  name: string;
  methods: MethodInfo[] = [];
  description?: string;

  constructor(name: string) {
    this.name = name;
  }

  withMethods(methods: Iterable<MethodInfo>): this {
    for (const m of methods) this.methods.push(m);
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      methods: this.methods,
    };
    if (this.description !== undefined) out.description = this.description;
    return out;
  }
}

export class InvokeResult {
  status: string;
  response?: string;
  durationMs: number;
  metadata: Record<string, string>;

  private constructor(status: string, response?: string) {
    this.status = status;
    this.response = response;
    this.durationMs = 0;
    this.metadata = {};
  }

  static ok(response: string): InvokeResult {
    return new InvokeResult("OK", response);
  }

  static err(status: string, response?: string): InvokeResult {
    return new InvokeResult(status, response);
  }

  withDurationMs(durationMs: number): this {
    this.durationMs = durationMs;
    return this;
  }

  withMetadata(metadata: Record<string, string>): this {
    this.metadata = { ...this.metadata, ...metadata };
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      status: this.status,
      durationMs: this.durationMs,
      metadata: this.metadata,
    };
    if (this.response !== undefined) out.response = this.response;
    return out;
  }
}

export class PluginSetting {
  key: string;
  label: string;
  type: string;
  defaultValue?: unknown;
  description?: string;
  required: boolean;

  constructor(key: string, label: string, type: string) {
    this.key = key;
    this.label = label;
    this.type = type;
    this.required = false;
  }

  withDefault(value: unknown): this {
    this.defaultValue = value;
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  makeRequired(): this {
    this.required = true;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      key: this.key,
      label: this.label,
      type: this.type,
      required: this.required,
    };
    if (this.defaultValue !== undefined) out.defaultValue = this.defaultValue;
    if (this.description !== undefined) out.description = this.description;
    return out;
  }
}
