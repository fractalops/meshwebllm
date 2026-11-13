import { test } from "node:test";
import assert from "node:assert/strict";
import { pack, unpack } from "../src/runtime/packet.js";
test("preserves typed activations, integer positions and nested metadata", () => {
  const input = {
    tokens: [1, 2],
    tensors: {
      hidden: {
        type: "float32",
        dims: [1, 1, 3],
        data: new Float32Array([1, -2.5, 0]),
      },
      position: { data: new BigInt64Array([9007199254740993n]) },
    },
    latency: 12.3,
  };
  assert.deepEqual(unpack(pack(input)), input);
});
test("rejects truncated metadata, truncated tensor and extra bytes", () => {
  const data = pack({ data: new Float32Array([1, 2, 3]) });
  for (const cut of [0, 3, 5, data.length - 1])
    assert.throws(() => unpack(data.subarray(0, cut)));
  assert.throws(() => unpack(new Uint8Array([...data, 0])));
});
