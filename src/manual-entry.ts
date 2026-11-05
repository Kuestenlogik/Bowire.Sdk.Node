import type { SettingOption } from "./models.js";

// How a call to this plugin is entered by hand, without discovery
// (Kuestenlogik/Bowire#1003). The plugin returns it from `manualEntry()`; the
// SDK puts it in the `initialize` reply as `manualEntry`, and the workbench
// renders a Compose form from it and offers exactly these method types in its
// freeform form. Shape: the Bowire repo's docs/architecture/sidecar-plugins.md,
// "A hand-entry form".

// How a call kind runs: Unary is invoke, ServerStreaming is invokeStream,
// ClientStreaming and Duplex open a channel.
export type ManualMethodType = "Unary" | "ServerStreaming" | "ClientStreaming" | "Duplex";

const METHOD_TYPES: readonly string[] = ["Unary", "ServerStreaming", "ClientStreaming", "Duplex"];

// One kind of call the plugin offers, e.g. produce or consume. `service` and
// `method` are templates: `{key}` is the value of the field with that key.
export interface ManualCallKind {
  id: string;
  label?: string;
  methodType: ManualMethodType;
  service?: string;
  method?: string;
  description?: string;
  bodyExample?: string;
}

// One field of the form. `placement` "template" feeds only the call kind's
// templates; "metadata" (the default) goes into the call's metadata under
// `key`. `callKinds` limits the field to those kinds; absent means all.
export interface ManualField {
  key: string;
  label?: string;
  placement?: "metadata" | "template";
  description?: string;
  placeholder?: string;
  required?: boolean;
  type?: "string" | "number" | "bool" | "select";
  options?: SettingOption[];
  defaultValue?: string;
  callKinds?: string[];
}

export interface ManualEntryForm {
  callKinds: ManualCallKind[];
  fields?: ManualField[];
  urlPlaceholder?: string;
}

// What is wrong with a form, or nothing — the same check the host runs before
// it serves one. The SDK refuses a form with a problem at `initialize`, so the
// plugin's author sees it rather than a form that silently never appears.
export function manualEntryProblems(form: ManualEntryForm): string[] {
  const problems: string[] = [];
  const kinds = form.callKinds ?? [];
  if (kinds.length === 0) problems.push("it offers no call kind");

  const kindIds = new Set<string>();
  for (const kind of kinds) {
    if (!kind.id) problems.push("a call kind has no id");
    else if (kindIds.has(kind.id)) problems.push(`call kind '${kind.id}' is declared twice`);
    else kindIds.add(kind.id);
    if (!METHOD_TYPES.includes(kind.methodType)) {
      problems.push(`call kind '${kind.id}' has method type '${String(kind.methodType)}'`);
    }
  }

  const fieldKeys = new Set<string>();
  for (const field of form.fields ?? []) {
    if (!field.key) problems.push("a field has no key");
    else if (fieldKeys.has(field.key)) problems.push(`field '${field.key}' is declared twice`);
    else fieldKeys.add(field.key);
    if (field.type === "select" && !(field.options && field.options.length > 0)) {
      problems.push(`select field '${field.key}' has no options`);
    }
    for (const id of field.callKinds ?? []) {
      if (!kindIds.has(id)) problems.push(`field '${field.key}' names unknown call kind '${id}'`);
    }
  }

  for (const kind of kinds) {
    for (const template of [kind.service ?? "", kind.method ?? ""]) {
      for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
        const key = match[1] ?? "";
        if (!fieldKeys.has(key)) {
          problems.push(`call kind '${kind.id}' uses the placeholder '${key}', which no field declares`);
        }
      }
    }
  }
  return problems;
}
