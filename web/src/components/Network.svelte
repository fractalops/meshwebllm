<script lang="ts">
  import type { Member } from "../types";
  import { shortId } from "../types";
  import { MODELS } from "../config";
  import Icon from "./Icon.svelte";
  import { Button } from "@ui-sdk/svelte/button";
  interface Props {
    members: Member[];
    neighbors: number;
    selfId: string;
    status: string;
    error: string;
    onchat: (model: string) => void;
    onretry: () => void;
  }
  let { members, neighbors, selfId, status, error, onchat, onretry }: Props =
    $props();
  const ready = $derived(
    members.filter((member) => !member.stale && member.info.state === "idle")
      .length,
  );
  function state(member: Member) {
    return member.stale
      ? "Offline"
      : typeof member.info.state === "object"
        ? `Loading ${member.info.state.loading.percent}%`
        : { idle: "Available", busy: "Answering", paused: "Paused" }[
            member.info.state
          ];
  }
</script>

<div class="network-page">
  <div class="page-heading">
    <span class="eyebrow">THE NETWORK</span>
    <h1>Browsers working together.</h1>
    <p>
      Each worker runs a model. A team of two devices appears as one worker.
    </p>
  </div>
  <div class="network-overview">
    <div><strong>{ready}</strong><span>Available workers</span></div>
    <div><strong>{neighbors}</strong><span>Connected peers</span></div>
    <div>
      <strong
        >{new Set(
          members
            .filter((member) => !member.stale)
            .map((member) => member.info.model),
        ).size}</strong
      ><span>Models online</span>
    </div>
  </div>
  <div class="section-heading">
    <h2>Live workers</h2>
    <span
      ><i class="status-dot" class:online={status === "connected"}
      ></i>{status === "connected"
        ? "Updated live"
        : status === "error"
          ? "Disconnected"
          : "Finding peers…"}</span
    >
  </div>
  {#if members.length}
    <div class="worker-list">
      {#each members as member (member.id)}
        <article class="worker-row">
          <span class="worker-icon"
            ><Icon
              name={member.info.adapter.includes("2 devices")
                ? "network"
                : "device"}
              size={21}
            /></span
          >
          <div class="worker-main">
            <h3>
              {MODELS.find((model) => model.id === member.info.model)?.name ??
                member.info.model}{#if member.id === selfId}<span class="badge"
                  >This device</span
                >{/if}
            </h3>
            <p>{member.info.adapter} <span>· {shortId(member.id)}</span></p>
          </div>
          <span
            class="worker-state"
            class:available={!member.stale && member.info.state === "idle"}
            ><i
              class="status-dot"
              class:online={!member.stale && member.info.state === "idle"}
            ></i>{state(member)}</span
          ><Button
            class="icon-button"
            aria-label={`Chat with ${MODELS.find((model) => model.id === member.info.model)?.name ?? "this model"}`}
            disabled={!MODELS.some((model) => model.id === member.info.model) ||
              member.stale ||
              (member.info.state !== "idle" && member.info.state !== "busy")}
            onclick={() => onchat(member.info.model)}
            ><Icon name="external" /></Button
          >
        </article>
      {/each}
    </div>
  {:else}<div class="network-empty">
      <Icon name="network" size={40} />
      <h3>
        {status === "error"
          ? "The connection was interrupted."
          : "No workers in view yet."}
      </h3>
      <p>
        {status === "error"
          ? "Reconnect to find the browsers sharing compute."
          : "Keep this page open while peers connect. You can also share compute from a supported device."}
      </p>
      {#if status === "error"}<Button class="button subtle" onclick={onretry}
          >Reconnect</Button
        >{/if}
    </div>{/if}
  <details class="connection-details">
    <summary>Connection details</summary>
    <dl>
      <div>
        <dt>Connection</dt>
        <dd>
          {status === "connected"
            ? "Connected to the pool"
            : status === "error"
              ? "Connection failed"
              : "Finding peers"}
        </dd>
      </div>
      <div>
        <dt>This device’s ID</dt>
        <dd class="mono">{selfId || "Connecting…"}</dd>
      </div>
      <div>
        <dt>Pool</dt>
        <dd class="mono">meshwebllm/pool/v1</dd>
      </div>
    </dl>
    {#if error}<p class="inline-error">{error}</p>{/if}
  </details>
  <p class="network-note">
    Availability can change when a browser closes or goes to sleep.
  </p>
</div>
