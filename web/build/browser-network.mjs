// Keep this workaround scoped to iroh's generated module. Safari rejects the
// DNS root dot in relay HTTPS/WebSocket URLs. Both default relays and relay
// addresses learned from native peers need normalization at the browser boundary.
// Do not change signed peer addresses or install global fetch/WebSocket patches.
export function scopeBrowserNetwork(source) {
  if (!source.includes("new WebSocket(") || !source.includes("new Request(")) {
    throw new Error("iroh browser bindings changed: review relay URL normalization");
  }
  return `
function browserNetworkUrl(input) {
  if (typeof input !== "string" && !(input instanceof URL)) return input;
  const url = new URL(input);
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url.href;
}
const WebSocket = class extends globalThis.WebSocket {
  constructor(url, protocols) { super(browserNetworkUrl(url), protocols); }
  static [Symbol.hasInstance](value) { return value instanceof globalThis.WebSocket; }
};
const Request = class extends globalThis.Request {
  constructor(input, options) { super(browserNetworkUrl(input), options); }
  static [Symbol.hasInstance](value) { return value instanceof globalThis.Request; }
};
${source}`;
}

export function browserNetworkPlugin() {
  return {
    name: "iroh-browser-network",
    enforce: "pre",
    transform(source, id) {
      if (id.split("?")[0].endsWith("/src/wasm/meshwebllm_web.js")) {
        return { code: scopeBrowserNetwork(source), map: null };
      }
    },
  };
}
