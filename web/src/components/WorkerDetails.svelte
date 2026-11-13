<script lang="ts">
  import { Button } from "@ui-sdk/svelte/button";
  import {
    Dialog,
    DialogBackdrop,
    DialogContent,
    DialogTitle,
    DialogDescription,
    DialogClose,
  } from "@ui-sdk/svelte/dialog";
  import type { Member } from "../types";
  import { shortId } from "../types";
  import { MODELS, SMOL_ID } from "../config";
  import {
    count,
    executionMode,
    relativeSeen,
    workerStatus,
    type NetworkHistory,
  } from "../network-state";
  import Icon from "./Icon.svelte";
  interface Props {
    id: string | null;
    member?: Member;
    selfId: string;
    history: NetworkHistory;
    now: number;
    canChat: boolean;
    onclose: () => void;
    onchat: (model: string) => void;
  }
  let { id, member, selfId, history, now, canChat, onclose, onchat }: Props =
    $props();
  const model = $derived(MODELS.find((m) => m.id === member?.info.model));
  const team = $derived(
    member ? executionMode(member) === "Two-device team" : false,
  );
  const events = $derived(
    history.events.filter((event) => event.worker === id).slice(0, 6),
  );
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
</script>

<Dialog
  open={id !== null}
  onOpenChange={(open) => {
    if (!open) onclose();
  }}
>
  <DialogBackdrop class="dialog-backdrop" />
  <DialogContent class="dialog worker-details" initialFocus="content">
    <div class="dialog-top">
      <span class="eyebrow">WORKER DETAILS</span><DialogClose
        class="icon-button"
        aria-label="Close worker details"><Icon name="close" /></DialogClose
      >
    </div>
    <DialogTitle>{model?.name ?? "Worker"}</DialogTitle>
    <DialogDescription
      >{id ? shortId(id) : ""}{id === selfId
        ? " · This device"
        : ""}</DialogDescription
    >
    {#if member}
      <div class="detail-status">
        <span
          class="state-pill"
          class:busy={!member.stale && member.info.state === "busy"}
          ><i
            class="status-dot"
            class:online={workerStatus(member) === "Available"}
          ></i>{workerStatus(member)}</span
        ><span>Seen {relativeSeen(member.lastSeenMs, now).toLowerCase()}</span>
      </div>
      <dl class="worker-facts">
        <div>
          <dt>Execution</dt>
          <dd>{executionMode(member)}</dd>
        </div>
        <div>
          <dt>Model runtime</dt>
          <dd>
            {model
              ? model.runtime === "onnx"
                ? "ONNX Runtime · WebGPU"
                : "WebLLM · WebGPU"
              : "Unknown"}
          </dd>
        </div>
        <div class="wide">
          <dt>Reported device</dt>
          <dd>
            {team
              ? member.info.adapter.slice(0, -" · 2 devices".length)
              : member.info.adapter || "Not reported"}
          </dd>
        </div>
        <div>
          <dt>Running / queued</dt>
          <dd>
            {member.stale
              ? "—"
              : `${count(member.info.active)} / ${count(member.info.waiting)}`}
          </dd>
        </div>
        <div>
          <dt>Last generation rate</dt>
          <dd>
            {member.stale || !member.info.tokensPerSec
              ? "—"
              : `${count(member.info.tokensPerSec).toFixed(1)} tokens/s`}
          </dd>
        </div>
        <div>
          <dt>Completed requests</dt>
          <dd>{count(member.info.served).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Tokens generated</dt>
          <dd>{count(member.info.tokensOut).toLocaleString()}</dd>
        </div>
        <div class="wide">
          <dt>Worker ID</dt>
          <dd class="endpoint-id">{member.id}</dd>
        </div>
      </dl>
      {#if team}
        <section class="execution-detail" aria-labelledby="execution-title">
          <h3 id="execution-title">Shared inference</h3>
          <p>
            One coordinator accepts the request. Two stages run the model in
            sequence.
          </p>
          {#if member.info.model === SMOL_ID}
            <ol
              class="execution-chain"
              aria-label="Reported two-device configuration"
            >
              <li>
                <span class="stage-number">01</span>
                <div>
                  <strong>Coordinator</strong><span>Layers 0–14</span><code
                    >{shortId(member.id)}</code
                  >
                </div>
              </li>
              <li>
                <span class="stage-number">02</span>
                <div>
                  <strong>Invited stage</strong><span>Layers 15–29</span><small
                    >Peer ID not advertised</small
                  >
                </div>
              </li>
            </ol>
          {/if}
          <p class="detail-note">
            Worker-reported configuration. Individual stage health is not
            advertised; the state above applies to the team.
          </p>
        </section>
      {/if}
      <section class="worker-recent" aria-labelledby="worker-recent-title">
        <h3 id="worker-recent-title">Recent activity</h3>
        {#if events.length}<ol>
            {#each events as event (event.id)}<li>
                <time datetime={new Date(event.at).toISOString()}
                  >{time(event.at)}</time
                ><span>{event.message}</span>
              </li>{/each}
          </ol>{:else}<p>No changes observed in this tab yet.</p>{/if}
      </section>
      <p class="detail-note">
        Counts are reported by this worker. Generation rate is from its last
        completed request, not current GPU utilization.
      </p>
      <div class="worker-detail-actions">
        <p>The network chooses a worker for this model.</p>
        <Button
          class="button primary"
          disabled={!canChat}
          onclick={() => onchat(member!.info.model)}
          >Chat with this model <Icon name="chat" size={16} /></Button
        >
      </div>
    {:else}
      <div class="worker-gone">
        <Icon name="network" size={28} />
        <h3>Worker left view</h3>
        <p>
          This worker is no longer in the roster. It may have closed its browser
          or lost its connection.
        </p>
        <DialogClose class="button subtle">Back to workers</DialogClose>
      </div>
    {/if}
  </DialogContent>
</Dialog>
