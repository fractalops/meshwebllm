import { MODELS, initialModel, SMOL_ID, bootstrapIds } from "./config";
import { MeshSession } from "./mesh-session";
import { Contributor, checkGpu, type GpuCheck } from "./contributor";
import { PoolChat } from "./chat";
import { chatCandidates } from "./chat-client";
import {
  invitationUrl,
  readInvitation,
  type Invitation,
} from "./runtime/split";
import { shortId, stateName, type Member } from "./types";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let model = initialModel(),
  session: MeshSession | undefined,
  contributor: Contributor | undefined,
  gpu: GpuCheck | undefined,
  roster: Member[] = [],
  neighbors = 0,
  invitation: Invitation | undefined;
const chat = new PoolChat(model),
  select = $<HTMLSelectElement>("modelSelect"),
  dialog = $<HTMLDialogElement>("contributeDialog");
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4500);
}
for (const m of MODELS) select.add(new Option(m.name, m.id));
select.value = model.id;
select.onchange = () => {
  model = MODELS.find((m) => m.id === select.value)!;
  chat.setModel(model);
  render();
};
function members(): Member[] {
  const own = contributor?.info();
  return own && session
    ? [
        {
          id: session.node.endpointId(),
          info: own,
          firstSeenMs: contributor!.startedAt,
          lastSeenMs: Date.now(),
          stale: false,
        },
        ...roster,
      ]
    : roster;
}
function gpuProblem() {
  return !gpu
    ? "Checking this GPU…"
    : model.runtime === "onnx"
      ? gpu.onnxProblem
      : gpu.webllmProblem;
}
function render() {
  const all = members(),
    available = chatCandidates(all, model.id).length,
    running = contributor?.running;
  $("modelDescription").textContent = model.description;
  $("modelDownload").textContent =
    model.downloadMB >= 1000
      ? `${(model.downloadMB / 1000).toFixed(2)} GB download`
      : `${model.downloadMB} MB download`;
  $("modelAvailability").textContent = `${available} ready`;
  $("networkCount").textContent = String(all.length);
  $("gpuHint").textContent =
    gpuProblem() ?? `${gpu?.name} · keep this tab visible`;
  $<HTMLButtonElement>("contribute").disabled = !session || !!gpuProblem();
  $("contribute").hidden = !!running;
  $("contributionActions").hidden = !running;
  $("pauseContribution").hidden = !contributor?.canPause;
  $("pauseContribution").textContent = contributor?.isPaused
    ? "Resume"
    : "Pause";
  const progress = contributor?.progress;
  $<HTMLButtonElement>("joinTeam").disabled =
    !contributor || !gpu || !!gpu.onnxProblem;
  const status = running
    ? `${contributor!.model!.name} · ${progress!.message}`
    : "You’re here to chat. Your GPU is off.";
  if ($("contributionStatus").textContent !== status)
    $("contributionStatus").textContent = status;
  $("contributionStatus").classList.toggle(
    "error",
    progress?.phase === "error",
  );
  $("contributionDot").classList.toggle(
    "on",
    !!running && progress?.phase !== "error",
  );
  const loading =
    !!progress &&
    ["downloading", "preparing", "pairing"].includes(progress.phase);
  $("contributionProgress").hidden = !loading;
  const meter = $<HTMLProgressElement>("downloadProgress");
  if (progress?.total) {
    meter.value = (100 * (progress.loaded ?? 0)) / progress.total;
    $("downloadLabel").textContent =
      `${((progress.loaded ?? 0) / 1e6).toFixed(1)} / ${(progress.total / 1e6).toFixed(1)} MB`;
  } else {
    meter.removeAttribute("value");
    $("downloadLabel").textContent =
      progress?.phase === "pairing"
        ? "Send the invitation to your other device"
        : "First load may take a moment";
  }
  $("copyInvite").hidden = !contributor?.invite;
  $("teamTopology").hidden = !(running && contributor?.mode === "shared");
  chat.update(session?.node, all, session?.node.endpointId() ?? "");
  $("readyCount").textContent = String(
    all.filter((m) => !m.stale && m.info.state === "idle").length,
  );
  $("servedCount").textContent = String(
    all.reduce((n, m) => n + m.info.served, 0),
  );
  $("tokenCount").textContent = all
    .reduce((n, m) => n + m.info.tokensOut, 0)
    .toLocaleString();
  $("workers").innerHTML = all.length
    ? all
        .map((m) => {
          const name =
              MODELS.find((x) => x.id === m.info.model)?.name ?? m.info.model,
            state = m.stale
              ? "offline"
              : typeof m.info.state === "string"
                ? stateName(m.info.state)
                : `loading ${m.info.state.loading.percent}%`;
          return `<article class="worker"><div><h3>${esc(name)} ${m.id === session?.node.endpointId() ? '<span class="badge">this device</span>' : ""}</h3><p>${esc(m.info.adapter)} · ${esc(shortId(m.id))}</p></div><div class="worker-meta"><span class="state">${state}</span><small>${m.info.served} replies · ${Number.isFinite(m.info.tokensPerSec) ? m.info.tokensPerSec.toFixed(1) : "–"} tok/s*</small></div></article>`;
        })
        .join("")
    : '<div class="network-empty">No workers are online yet.<br>Contribute compute to give the network its first model.</div>';
  $("discoveryStatus").textContent =
    `${neighbors} connected peer${neighbors === 1 ? "" : "s"}${bootstrapIds().length ? " · public bootstrap" : " · no bootstrap configured"}`;
  if (session) {
    $("networkStatus").innerHTML =
      `<i></i>${neighbors ? "Pool connected" : "Ready · finding peers"}`;
    $("networkStatus").classList.add("online");
    $("endpointId").textContent = session.node.endpointId();
  }
}
function showView(network: boolean) {
  $("chatView").hidden = network;
  $("networkView").hidden = !network;
  for (const [id, active] of [
    ["viewChat", !network],
    ["viewNetwork", network],
  ] as const) {
    $(id).classList.toggle("active", active);
    $(id).setAttribute("aria-pressed", String(active));
  }
  render();
}
$("viewChat").onclick = () => showView(false);
$("viewNetwork").onclick = () => showView(true);
function openContribution() {
  if (!session) return toast("Still connecting. Try again in a moment.");
  if (contributor?.running)
    return toast("This device is already contributing.");
  $("dialogModel").textContent =
    `${model.name} · ${model.downloadMB >= 1000 ? (model.downloadMB / 1000).toFixed(2) + " GB" : model.downloadMB + " MB"} downloaded once and cached in your browser.`;
  $("sharedOption").hidden = !model.shared;
  $("sharedCaveat").hidden = !model.shared;
  (
    document.querySelector(
      'input[name="contributionMode"][value="whole"]',
    ) as HTMLInputElement
  ).checked = true;
  $("dialogError").textContent = gpuProblem() ?? "";
  $<HTMLButtonElement>("startContribution").disabled = !!gpuProblem();
  dialog.showModal();
}
$("contribute").onclick = openContribution;
$("emptyContribute").onclick = openContribution;
$("startContribution").onclick = () => {
  const mode = (
    document.querySelector(
      'input[name="contributionMode"]:checked',
    ) as HTMLInputElement
  ).value as "whole" | "shared";
  dialog.close();
  void contributor!.start(model, mode).catch((e) => toast(String(e)));
};
$("pauseContribution").onclick = () => contributor?.pause();
$("stopContribution").onclick = () => {
  void contributor?.stop().catch((e) => toast(String(e)));
};
$("copyInvite").onclick = async () => {
  if (!contributor?.invite) return;
  try {
    await navigator.clipboard.writeText(invitationUrl(contributor.invite));
    toast("Invitation copied. Open it on the other device.");
  } catch {
    toast("Clipboard is unavailable in this browser.");
  }
};
$("joinTeam").onclick = () => {
  if (!invitation || !contributor) return;
  if (contributor.running)
    return toast("Stop this device’s current contribution before joining.");
  model = MODELS.find((m) => m.id === SMOL_ID)!;
  select.value = model.id;
  chat.setModel(model);
  if (gpuProblem()) return toast(gpuProblem()!);
  $("inviteBanner").hidden = true;
  void contributor
    .start(model, "helper", invitation)
    .catch((e) => toast(String(e)));
};
$("dismissInvite").onclick = () => {
  invitation = undefined;
  $("inviteBanner").hidden = true;
  history.replaceState(null, "", location.pathname + location.search);
};
try {
  invitation = readInvitation(location.hash);
  $("inviteBanner").hidden = !invitation;
} catch (e) {
  toast(e instanceof Error ? e.message : String(e));
}
void (async () => {
  try {
    gpu = await checkGpu();
    render();
    session = await MeshSession.connect((members, count) => {
      roster = members;
      neighbors = count;
      render();
    });
    contributor = new Contributor(session.node, gpu.name, render);
    render();
  } catch (error) {
    $("networkStatus").textContent = "Connection failed";
    $("gpuHint").textContent =
      error instanceof Error ? error.message : String(error);
    toast("Could not connect. Reload to try again.");
  }
})();
window.addEventListener("pagehide", () => {
  void contributor?.dispose();
  void session?.close();
});
render();
