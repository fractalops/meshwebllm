import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { scopeBrowserNetwork, browserNetworkPlugin } from "../build/browser-network.mjs";

test("iroh bindings normalize relay URLs without replacing browser globals", async () => {
  // Exercise the same constructors and transform as the real generated bindings.
  const source = await readFile(new URL("../src/wasm/meshwebllm_web.js", import.meta.url), "utf8");
  assert.match(source, /new WebSocket\(/);
  assert.match(source, /new Request\(/);
  const plugin = browserNetworkPlugin();
  assert.ok(plugin.transform(source, "/project/web/src/wasm/meshwebllm_web.js").code.includes("const WebSocket = class"));
  assert.equal(plugin.transform(source, "/project/web/src/runtime/model-worker.js"), undefined);
  assert.throws(() => scopeBrowserNetwork("changed upstream bindings"), /bindings changed/);
  const nativeSocket = globalThis.WebSocket;
  const nativeRequest = globalThis.Request;
  class Socket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; }
  }
  globalThis.WebSocket = Socket;
  try {
    const transformed = scopeBrowserNetwork(`
      export const socket = (url, protocols) => new WebSocket(url, protocols);
      export const request = (url, options) => new Request(url, options);
    `);
    const bindings = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
    const protocols = ["iroh-relay-v1"];
    const socket = bindings.socket("wss://euc1-1.relay.n0.iroh.link./relay?token=abc", protocols);
    assert.equal(socket.url, "wss://euc1-1.relay.n0.iroh.link/relay?token=abc");
    assert.equal(socket.protocols, protocols);
    assert.ok(socket instanceof Socket);
    const controller = new AbortController();
    const request = bindings.request("https://euc1-1.relay.n0.iroh.link./ping", {
      method: "POST", body: "probe", headers: { "x-test": "kept" }, signal: controller.signal,
    });
    assert.equal(request.url, "https://euc1-1.relay.n0.iroh.link/ping");
    assert.equal(request.method, "POST");
    assert.equal(await request.text(), "probe");
    assert.equal(request.headers.get("x-test"), "kept");
    controller.abort();
    assert.ok(request.signal.aborted);
    for (const url of ["ws://127.0.0.1:3340/relay", "ws://[::1]:3340/relay", "wss://relay.example/relay?next=host."]) {
      assert.equal(bindings.socket(url).url, url);
    }
    assert.equal(globalThis.WebSocket, Socket);
    assert.equal(globalThis.Request, nativeRequest);
  } finally {
    globalThis.WebSocket = nativeSocket;
  }
});
