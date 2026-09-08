export class CommandJsonError extends Error {
  constructor(reason: string) {
    super(`command JSON cannot be canonicalized: ${reason}`);
    this.name = "CommandJsonError";
  }
}

function jsonString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new CommandJsonError("invalid Unicode string");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CommandJsonError("invalid Unicode string");
    }
  }

  return JSON.stringify(value);
}

function encode(value: unknown, ancestors: readonly object[]): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CommandJsonError("non-finite number");

    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new CommandJsonError("non-JSON value");
  if (ancestors.includes(value)) throw new CommandJsonError("cyclic value");
  if (ancestors.length >= 64) throw new CommandJsonError("nesting exceeds 64 levels");
  const next = [...ancestors, value];

  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw new CommandJsonError("sparse or extended array");

    return `[${value.map((item: unknown) => encode(item, next)).join(",")}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null)
    throw new CommandJsonError("non-plain object");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new CommandJsonError("symbol property");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.keys(descriptors).sort().map((key) => {
    const descriptor = descriptors[key];

    if (!descriptor.enumerable || !("value" in descriptor))
      throw new CommandJsonError("non-data property");

    return `${jsonString(key)}:${encode(descriptor.value, next)}`;
  });

  return `{${entries.join(",")}}`;
}

/** RFC 8785 JCS: preserve array order and Unicode, sort keys by UTF-16 units.
 * Optional fields must be normalized by the request schema before this call.
 * Errors contain only structural reasons, never command content.
 */
export function canonicalCommandJson(value: unknown): string {
  return encode(value, []);
}
