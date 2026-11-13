// Stage protocol v1 envelope: u32 JSON length, UTF-8 metadata, then raw tensor bytes.
const types = {
  Float32Array,
  Float64Array,
  Int32Array,
  BigInt64Array,
  Uint8Array,
  Uint16Array,
};
export function pack(value) {
  const chunks = [];
  const json = new TextEncoder().encode(
    JSON.stringify(value, (_, v) => {
      if (!ArrayBuffer.isView(v)) return v;
      if (!types[v.constructor.name])
        throw new Error("Unsupported tensor type");
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const descriptor = {
        tensor: chunks.length,
        type: v.constructor.name,
        bytes: bytes.length,
      };
      chunks.push(bytes);
      return descriptor;
    }),
  );
  const bytes = new Uint8Array(
    4 + json.length + chunks.reduce((n, b) => n + b.length, 0),
  );
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);
  let offset = 4 + json.length;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function unpack(bytes) {
  if (bytes.byteLength < 4) throw new Error("Truncated packet");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
  let offset = 4 + length,
    index = 0;
  if (offset > bytes.length) throw new Error("Truncated metadata");
  const value = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, offset)),
    (_, v) => {
      if (v && typeof v === "object" && "tensor" in v) {
        const Type = types[v.type];
        if (
          !Type ||
          v.tensor !== index++ ||
          !Number.isSafeInteger(v.bytes) ||
          v.bytes < 0 ||
          v.bytes % Type.BYTES_PER_ELEMENT ||
          offset + v.bytes > bytes.length
        )
          throw new Error("Invalid tensor descriptor");
        const data = bytes.slice(offset, offset + v.bytes);
        offset += v.bytes;
        return new Type(data.buffer);
      }
      return v;
    },
  );
  if (offset !== bytes.length) throw new Error("Trailing tensor data");
  return value;
}
