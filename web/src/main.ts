import init, { MeshNode } from "./wasm/meshwebllm_web.js";
import { HEARTBEAT_S, MODEL, POOL_NAME, STALE_S, bootstrapIds } from "./config";
import { Contributor, describeAdapter } from "./contributor";
import { type Member, type PoolEvent, shortId, stateName } from "./types";

const KEY_STORAGE = "meshwebllm.secretKey";
const STATUS = ["All", "busy", "idle", "loading", "paused", "stale"] as const;
const SORTS = ["Load", "tok/s", "Served", "Uptime", "Beat"] as const;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let node: MeshNode | undefined;
let me: Contributor | undefined;
let adapter: string | null = null;
let rows: Member[] = [];
let sel: string | null = null;
let fStatus = 0;
let fArch = 0;
let fSort = 0;

/** Per-worker reported speed, one sample per second, for sparklines. */
const history = new Map<string, number[]>();
/** Pool speed, one sample per second. */
const poolHistory: number[] = [];
/** Last `served` value per worker, to count completions per minute. */
const lastServed = new Map<string, number>();
const completions: number[] = [];

function readKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeKey(hex: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, hex);
  } catch {
    // The ID changes on the next visit. The page still works.
  }
}

function log(msg: string, cls = ""): void {
  const li = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toTimeString().slice(0, 8);
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = msg;
  li.append(time, span);
  const el = $("log");
  el.prepend(li);
  while (el.children.length > 100) el.lastChild?.remove();
}

function notice(html: string | null): void {
  $("notice").hidden = html === null;
  if (html !== null) $("noticeText").innerHTML = html;
}

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const dur = (s: number) =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function status(m: Member): string {
  return m.stale ? "stale" : stateName(m.info.state);
}

function beatAge(m: Member): number {
  return Math.max(0, Math.floor((Date.now() - m.lastSeenMs) / 1000));
}

function load(m: Member): number {
  return status(m) === "busy" ? m.info.active + m.info.waiting : 0;
}

/** This tab as a roster row, when it is a worker. */
function selfMember(): Member | null {
  if (!me || !node) return null;
  const now = Date.now();
  return { id: node.endpointId(), info: me.info(), firstSeenMs: me.startedAt, lastSeenMs: now, stale: false };
}

function allRows(): Member[] {
  const self = selfMember();
  return self ? [self, ...rows] : rows;
}

function adapters(): string[] {
  return ["All", ...new Set(allRows().map((m) => m.info.adapter))];
}

function visible(): Member[] {
  const q = ($("q") as HTMLInputElement).value.trim().toLowerCase();
  const arch = adapters()[fArch] ?? "All";
  const list = allRows().filter(
    (m) =>
      (fStatus === 0 || status(m) === STATUS[fStatus]) &&
      (arch === "All" || m.info.adapter === arch) &&
      (!q || m.id.includes(q) || m.info.adapter.toLowerCase().includes(q) || status(m).includes(q)),
  );
  const key: Record<(typeof SORTS)[number], (m: Member) => number> = {
    Load: (m) => (m.stale ? -1e6 : 0) + load(m) * 1e4 + m.info.tokensPerSec,
    "tok/s": (m) => m.info.tokensPerSec,
    Served: (m) => m.info.served,
    Uptime: (m) => m.info.uptimeSecs,
    Beat: (m) => beatAge(m),
  };
  const by = key[SORTS[fSort]];
  const selfId = node?.endpointId();
  return list.sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId) || by(b) - by(a));
}

function bar(m: Member): string {
  const cells = 4;
  const st = status(m);
  const pct = typeof m.info.state === "string" ? 0 : m.info.state.loading.percent;
  const fill = st === "loading" ? Math.round((pct / 100) * cells) : Math.min(cells, load(m));
  const cls = st === "loading" ? "acc" : load(m) >= 3 ? "bad" : load(m) >= 1 ? "busy" : "ok";
  return `<span class="bar ${cls}">${"█".repeat(fill)}</span><span class="bar dim">${"░".repeat(cells - fill)}</span>`;
}

const STATUS_CLASS: Record<string, string> = { busy: "busy", idle: "ok", loading: "acc", paused: "dim", stale: "bad" };

function statusCell(m: Member): string {
  const st = status(m);
  const label =
    st === "loading" && typeof m.info.state !== "string" ? `loading ${m.info.state.loading.percent}%` : st;
  return `<span class="${STATUS_CLASS[st]}">${label}</span>`;
}

function spark(svg: SVGElement, data: number[], h: number): void {
  if (data.length < 2) {
    svg.innerHTML = "";
    return;
  }
  const max = Math.max(1, ...data);
  const n = data.length - 1;
  const pts = data.map((v, i) => [(i / n) * 100, h - 2 - (v / max) * (h - 4)]);
  const line = pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  svg.innerHTML =
    `<line x1="0" x2="100" y1="${h - 1}" y2="${h - 1}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `<polygon points="0,${h} ${line} 100,${h}" fill="var(--accent)" fill-opacity="0.15"/>` +
    `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${lx}" cy="${ly}" r="2" fill="var(--accent)"/>`;
}

function render(): void {
  const list = visible();
  const selfId = node?.endpointId();
  $("rows").innerHTML = list.length
    ? list
        .map((m) => {
          const age = beatAge(m);
          const beat = age >= STALE_S ? `<span class="bad">${age}s</span>` : age >= HEARTBEAT_S * 2 ? `<span class="busy">${age}s</span>` : `${age}s`;
          const jobs = m.info.active + m.info.waiting;
          return `<tr data-id="${m.id}" class="${m.id === sel ? "sel" : ""} ${m.id === selfId ? "me" : ""}">
          <td class="dot ${STATUS_CLASS[status(m)]}">●</td><td>${shortId(m.id)}</td><td class="dim">${esc(m.info.adapter)}</td>
          <td>${statusCell(m)}</td><td>${bar(m)}</td>
          <td class="n">${jobs ? `${m.info.active}${m.info.waiting ? `<span class="dim">+${m.info.waiting}</span>` : ""}` : `<span class="dim">0</span>`}</td>
          <td class="n">${m.info.served}</td><td class="n">${fmt(m.info.tokensOut)}</td>
          <td class="n">${m.info.tokensPerSec ? m.info.tokensPerSec.toFixed(1) : `<span class="dim">—</span>`}</td>
          <td class="n dim">${dur(m.info.uptimeSecs)}</td><td class="n">${beat}</td></tr>`;
        })
        .join("")
    : `<tr class="empty"><td colspan="11">${
        allRows().length ? "No worker matches the filters." : "No workers yet. Workers appear here when they announce themselves."
      }</td></tr>`;
  $("countShown").textContent = String(list.length);
  $("countAll").textContent = String(allRows().length);

  const all = allRows();
  const count = (s: string) => all.filter((m) => status(m) === s).length;
  $("sWorkers").textContent = String(all.length);
  $("sWorkersSub").innerHTML = `<span class="busy">${count("busy")} busy</span> · <span class="ok">${count("idle")} idle</span> · <span class="acc">${count("loading")} loading</span> · <span class="bad">${count("stale")} stale</span>`;
  $("sTps").textContent = String(Math.round(poolHistory[poolHistory.length - 1] ?? 0));
  spark($("sTpsSpark") as unknown as SVGElement, poolHistory, 26);
  $("sCpm").textContent = String(completions.length);
  $("sQueue").textContent = `${all.reduce((a, m) => a + m.info.waiting, 0)} jobs waiting`;
  $("sTokens").textContent = fmt(all.reduce((a, m) => a + m.info.tokensOut, 0));
  $("gossipPeers").textContent = node ? `${node.neighbors()} neighbors` : "–";

  $("fStatus").textContent = STATUS[fStatus];
  $("fArch").textContent = adapters()[fArch] ?? "All";
  $("fSort").textContent = SORTS[fSort];

  const btn = $<HTMLButtonElement>("contribute");
  btn.disabled = !node || adapter === null;
  btn.textContent = !me ? "Contribute my GPU [c]" : me.isPaused ? "Resume [p]" : "Pause [p]";
  btn.classList.toggle("on", !!me && !me.isPaused);
  $("youMode").textContent = me ? "worker" : "observer";
  $("mode").textContent = me ? "WORKER" : "OBSERVE";
  renderDetail();
}

function renderDetail(): void {
  const el = $("detail");
  const m = allRows().find((x) => x.id === sel);
  if (!m) {
    el.className = "dim";
    el.textContent = "Select a worker with ↑↓ or a click.";
    return;
  }
  const isMe = m.id === node?.endpointId();
  el.className = "";
  el.innerHTML = `<div class="acc">${shortId(m.id)}${isMe ? " (you)" : ""}</div>
    <dl>
      <dt>endpoint</dt><dd class="dim">${m.id}</dd>
      <dt>ask</dt><dd><button id="copyAsk">copy command</button></dd>
      <dt>adapter</dt><dd>${esc(m.info.adapter)}</dd>
      <dt>model</dt><dd>${esc(m.info.model)}</dd>
      <dt>status</dt><dd>${statusCell(m)}</dd>
      <dt>served</dt><dd>${m.info.served} completions · ${fmt(m.info.tokensOut)} tokens</dd>
      <dt>tok/s</dt><dd>${m.info.tokensPerSec.toFixed(1)} <span class="dim">reported</span></dd>
      <dt>heartbeat</dt><dd>${beatAge(m)}s ago · signed <span class="ok">✓</span></dd>
    </dl>
    <svg id="dSpark" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"></svg>
    <div class="dim" style="font-size:12px">${isMe ? "tokens per second, last 60 s" : "reported tokens per second while busy, last 60 s"}</div>`;
  const series = isMe && me ? me.history : history.get(m.id) ?? [];
  spark($("dSpark") as unknown as SVGElement, series, 60);
  $("copyAsk").onclick = () => {
    const cmd = `meshwebllm ask --worker ${m.id} "Hello"`;
    navigator.clipboard.writeText(cmd).then(
      () => log("copied the ask command", "dim"),
      () => log(cmd, "dim"),
    );
  };
}

/** Samples the roster once per second. */
function tick(): void {
  if (!node) return;
  try {
    rows = node.roster() as Member[];
  } catch (err) {
    console.warn("roster failed", err);
  }
  const now = Date.now();
  let pool = 0;
  for (const m of allRows()) {
    const busy = status(m) === "busy";
    const v = busy ? m.info.tokensPerSec : 0;
    pool += v;
    const h = history.get(m.id) ?? [];
    h.push(v);
    if (h.length > 60) h.shift();
    history.set(m.id, h);
    const prev = lastServed.get(m.id);
    if (prev !== undefined && m.info.served > prev) {
      for (let i = prev; i < m.info.served; i++) completions.push(now);
    }
    lastServed.set(m.id, m.info.served);
  }
  poolHistory.push(pool);
  if (poolHistory.length > 60) poolHistory.shift();
  while (completions.length && now - completions[0] > 60_000) completions.shift();
  if (sel && !allRows().some((m) => m.id === sel)) sel = null;
  render();
}

async function watchEvents(n: MeshNode): Promise<void> {
  const reader = n.events().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const ev = value as PoolEvent;
    const id = shortId(ev.id);
    if (ev.kind === "joined") log(`${id} joined`, "acc");
    else if (ev.kind === "left") log(`${id} left`, "dim");
    else if (ev.kind === "stale") log(`${id} missed ${STALE_S / HEARTBEAT_S} heartbeats, marked stale`, "busy");
    else {
      log(`${id} removed after 45 s without a heartbeat`, "bad");
      history.delete(ev.id);
      lastServed.delete(ev.id);
    }
  }
}

// Interaction

function move(d: number): void {
  const list = visible();
  if (!list.length) return;
  let i = list.findIndex((m) => m.id === sel);
  i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d));
  sel = list[i].id;
  render();
  $("rows").querySelector(`tr[data-id="${sel}"]`)?.scrollIntoView({ block: "nearest" });
}

function openDialog(): void {
  if (me) return togglePause();
  if (!node || adapter === null) return;
  $("overlay").hidden = false;
  $("dlgOk").focus();
}

function closeDialog(): void {
  $("overlay").hidden = true;
  $("contribute").focus();
}

function togglePause(): void {
  if (me) {
    me.setPaused(!me.isPaused);
    render();
  }
}

async function contribute(): Promise<void> {
  closeDialog();
  if (!node || adapter === null || me) return;
  me = new Contributor(node, adapter, log);
  sel = node.endpointId();
  log(`downloading ${MODEL.id} (${MODEL.downloadGB} GB)`, "acc");
  render();
  try {
    await me.start();
  } catch (err) {
    log(`the model did not load: ${String(err)}`, "bad");
    me = undefined;
  }
  render();
}

function bindUi(): void {
  const cycle = (v: number, n: number) => (v + 1) % n;
  $("rows").addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest("tr[data-id]") as HTMLElement | null;
    if (tr) {
      sel = tr.dataset.id ?? null;
      render();
    }
  });
  $("fStatus").onclick = () => ((fStatus = cycle(fStatus, STATUS.length)), render());
  $("fArch").onclick = () => ((fArch = cycle(fArch, adapters().length)), render());
  $("fSort").onclick = () => ((fSort = cycle(fSort, SORTS.length)), render());
  $("q").addEventListener("input", render);
  $("contribute").onclick = openDialog;
  $("dlgCancel").onclick = closeDialog;
  $("dlgOk").onclick = () => void contribute();

  document.addEventListener("keydown", (e) => {
    if (!$("overlay").hidden) {
      if (e.key === "Escape") closeDialog();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.id === "q") {
      if (e.key === "Escape" || e.key === "Enter") target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        move(1);
        e.preventDefault();
        break;
      case "ArrowUp":
      case "k":
        move(-1);
        e.preventDefault();
        break;
      case "/":
        $("q").focus();
        e.preventDefault();
        break;
      case "s":
        fStatus = cycle(fStatus, STATUS.length);
        render();
        break;
      case "a":
        fArch = cycle(fArch, adapters().length);
        render();
        break;
      case "o":
        fSort = cycle(fSort, SORTS.length);
        render();
        break;
      case "c":
        openDialog();
        break;
      case "p":
        togglePause();
        break;
      case "Escape":
        sel = null;
        ($("q") as HTMLInputElement).value = "";
        fStatus = fArch = 0;
        render();
        break;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (me && document.hidden) log("this tab is hidden. The browser can freeze it and stop jobs.", "busy");
  });
  window.addEventListener("pagehide", () => {
    if (me && node) void node.leave();
  });
}

async function main(): Promise<void> {
  $("poolName").textContent = POOL_NAME;
  $("modelName").textContent = MODEL.id;
  $("modelSize").textContent = `(${MODEL.downloadGB} GB · ~${MODEL.vramGB} GB VRAM)`;
  $("dlgModel").textContent = MODEL.id;
  $("dlgSize").textContent = `${MODEL.downloadGB} GB`;
  $("dlgVram").textContent = `${MODEL.vramGB} GB`;
  bindUi();
  render();

  adapter = await describeAdapter().catch(() => null);
  $("dlgGpu").textContent = adapter ? `Detected GPU: ${adapter}` : "";
  if (adapter === null) {
    log("this browser has no WebGPU. You can watch the pool but not contribute.", "busy");
  }

  const bootstrap = bootstrapIds();
  if (bootstrap.length === 0) {
    notice(
      "No bootstrap node is set, so this page cannot find other members. Add <code>?bootstrap=ENDPOINT_ID</code> to the address. Run <code>meshwebllm bootstrap</code> to start a bootstrap node.",
    );
  }

  try {
    await init();
    node = await MeshNode.spawn(readKey(), POOL_NAME, bootstrap);
  } catch (err) {
    $("netStatus").textContent = "failed";
    $("netStatus").className = "bad";
    log(`could not start the network node: ${String(err)}`, "bad");
    return;
  }
  writeKey(node.secretKeyHex());
  $("netStatus").textContent = "online";
  $("netStatus").className = "ok";
  $("youId").textContent = shortId(node.endpointId());
  log(`joined ${POOL_NAME} as ${shortId(node.endpointId())}`, "acc");
  void watchEvents(node);
  tick();
  setInterval(tick, 1000);
}

void main();
