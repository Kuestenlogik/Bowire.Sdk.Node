import type { PluginSetting } from "./models.js";

// The values behind the settings a plugin declared (#693), as the host sent
// them with one call.
//
// The host reads its settings store on the plugin's behalf and puts a
// `settings` object on the params of discover, invoke, invokeStream and
// openChannel. A fresh instance arrives with every call, so a changed setting
// takes effect without restarting the sidecar. Two rules of that wire shape
// decide how the accessors behave:
//
// - Values are strings whatever the declared `type`. The accessors parse what
//   the setting declared.
// - Only keys that are actually set travel. An absent key means "use the
//   default you declared", so the accessors fall back to the declaration's
//   `defaultValue`.
//
// A value that does not parse as the requested type is treated as absent:
// the declared default applies. A hand-edited settings file should not take
// the plugin down.
export class SettingValues {
  private readonly values: ReadonlyMap<string, string>;
  private readonly declared: ReadonlyMap<string, PluginSetting>;

  constructor(
    values: Readonly<Record<string, string>> = {},
    declared: Iterable<PluginSetting> = [],
  ) {
    this.values = new Map(Object.entries(values));
    this.declared = new Map([...declared].map((s) => [s.key, s]));
  }

  // Build from the raw `settings` param. Anything but an object is "nothing
  // set"; primitive values are taken as their text, since the host's store
  // tolerates a JSON number or boolean in a hand-edited file too.
  static fromWire(raw: unknown, declared: Iterable<PluginSetting> = []): SettingValues {
    const values: Record<string, string> = {};
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string") values[key] = value;
        else if (typeof value === "number" || typeof value === "boolean") {
          values[key] = String(value);
        }
      }
    }
    return new SettingValues(values, declared);
  }

  // Whether the host sent a value for `key` with this call.
  has(key: string): boolean {
    return this.values.has(key);
  }

  // The text the host sent, or undefined when the key is not set. No
  // default applies.
  raw(key: string): string | undefined {
    return this.values.get(key);
  }

  // Keys the host sent a value for.
  keys(): string[] {
    return [...this.values.keys()];
  }

  // The value as text. Falls back to the declared default, then to
  // `fallback`; throws when there is neither, because reading a setting
  // nobody declared a default for is a bug in the plugin.
  string(key: string, fallback?: string): string {
    return this.resolve(key, fallback, parseString);
  }

  // The value as a boolean: "true" / "false" (any case), "1" / "0".
  bool(key: string, fallback?: boolean): boolean {
    return this.resolve(key, fallback, parseBool);
  }

  // The value as a finite number.
  number(key: string, fallback?: number): number {
    return this.resolve(key, fallback, parseNumber);
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  private resolve<T>(
    key: string,
    fallback: T | undefined,
    parse: (value: unknown) => T | undefined,
  ): T {
    const sent = this.values.get(key);
    if (sent !== undefined) {
      const parsed = parse(sent);
      if (parsed !== undefined) return parsed;
    }

    const declaredDefault = this.declared.get(key)?.defaultValue;
    if (declaredDefault !== undefined) {
      const parsed = parse(declaredDefault);
      if (parsed !== undefined) return parsed;
    }

    if (fallback !== undefined) return fallback;
    throw new Error(
      `setting '${key}' has no value, no usable declared default and no fallback`,
    );
  }
}

function parseString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}
