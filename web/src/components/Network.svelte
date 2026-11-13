<script lang="ts">
  import { Button } from "@ui-sdk/svelte/button";
  import { Input } from "@ui-sdk/svelte/input";
  import { Field, FieldLabel } from "@ui-sdk/svelte/field";
  import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
    SelectLabel,
  } from "@ui-sdk/svelte/select";
  import type { Member } from "../types";
  import { shortId } from "../types";
  import { MODELS } from "../config";
  import { count, workerStatus, type NetworkHistory } from "../network-state";
  import Icon from "./Icon.svelte";
  interface Props {
    members: Member[];
    neighbors: number;
    selfId: string;
    status: string;
    error: string;
    history: NetworkHistory;
    onchat: (model: string) => void;
    onretry: () => void;
  }
  let {
    members,
    neighbors,
    selfId,
    status,
    error,
    history,
    onchat,
    onretry,
  }: Props = $props();
  let query = $state(""),
    filter = $state<string | null>("all");
  const live = $derived(members.filter((m) => !m.stale));
  const ready = $derived(live.filter((m) => m.info.state === "idle").length);
  const active = $derived(live.reduce((n, m) => n + count(m.info.active), 0));
  const queued = $derived(live.reduce((n, m) => n + count(m.info.waiting), 0));
  const tokens = $derived(
    live.reduce((n, m) => n + count(m.info.tokensOut), 0),
  );
  const served = $derived(live.reduce((n, m) => n + count(m.info.served), 0));
  const models = $derived(
    MODELS.map((model) => {
      const workers = live.filter((m) => m.info.model === model.id);
      return {
        ...model,
        workers: workers.length,
        ready: workers.filter((m) => m.info.state === "idle").length,
      };
    }),
  );
  const visible = $derived(
    members.filter((m) => {
      const state = workerStatus(m);
      return (
        (filter === "all" || state.toLowerCase() === filter) &&
        `${name(m.info.model)} ${m.id} ${m.info.adapter}`
          .toLowerCase()
          .includes(query.toLowerCase().trim())
      );
    }),
  );
  const formatter = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const format = (value: number) => formatter.format(count(value));
  const name = (id: string) => MODELS.find((m) => m.id === id)?.name ?? id;
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  const peak = $derived(
    Math.max(1, ...history.samples.map((s) => s.active + s.queued)),
  );
  const points = $derived(
    history.samples
      .map(
        (s) =>
          `${((s.at - history.samples[0].at) / Math.max(1, history.samples.at(-1)!.at - history.samples[0].at)) * 600},${100 - (s.active / peak) * 85}`,
      )
      .join(" "),
  );
  const queuePoints = $derived(
    history.samples
      .map(
        (s) =>
          `${((s.at - history.samples[0].at) / Math.max(1, history.samples.at(-1)!.at - history.samples[0].at)) * 600},${100 - (s.queued / peak) * 85}`,
      )
      .join(" "),
  );
  const latest = $derived(history.samples.at(-1)?.at);
</script>

<div class="dashboard">
  <header class="dashboard-heading">
    <div>
      <span class="eyebrow">POOL / OVERVIEW</span>
      <h1>Network</h1>
      <p>The compute available to this browser, right now.</p>
    </div>
    <div class="dashboard-live">
      <span
        ><i class="status-dot" class:online={status === "connected"}
        ></i>{status === "connected"
          ? "Live updates"
          : status === "error"
            ? "Disconnected"
            : "Finding peers"}</span
      ><small
        >{latest
          ? `Observed ${time(latest)}`
          : "Waiting for observations"}</small
      >
    </div>
  </header>
  <div class="metric-grid" aria-label="Network metrics">
    <div class="metric-card">
      <span>Available workers</span><strong
        >{ready}<small>/ {live.length}</small></strong
      >
      <p>
        {live.length
          ? `${live.length - ready} loading, busy, or paused`
          : "Waiting for the first worker"}
      </p>
    </div>
    <div class="metric-card">
      <span>Active requests</span><strong>{format(active)}</strong>
      <p>{format(queued)} waiting in worker queues</p>
    </div>
    <div class="metric-card">
      <span>Completed requests</span><strong>{format(served)}</strong>
      <p>Reported by workers in view</p>
    </div>
    <div class="metric-card">
      <span>Tokens generated</span><strong>{format(tokens)}</strong>
      <p>Reported by workers in view</p>
    </div>
  </div>

  <div class="dashboard-grid">
    <section class="dash-panel workers-panel" aria-labelledby="workers-title">
      <div class="panel-heading">
        <h2 id="workers-title">Workers <span>{members.length}</span></h2>
        <span class="panel-meta">LIVE ROSTER</span>
      </div>
      <div class="worker-filters">
        <Field
          ><FieldLabel class="sr-only">Find a worker</FieldLabel><Input
            value={query}
            onValueChange={(v) => (query = v)}
            placeholder="Search model, device, or ID…"
            class="dashboard-search"
          /></Field
        >
        <Select
          bind:value={filter}
          items={[
            { value: "all", label: "All states" },
            { value: "available", label: "Available" },
            { value: "answering", label: "Answering" },
            { value: "loading", label: "Loading" },
            { value: "paused", label: "Paused" },
            { value: "offline", label: "Offline" },
          ]}
        >
          <SelectLabel class="sr-only">Filter workers by state</SelectLabel
          ><SelectTrigger class="dashboard-filter"
            ><SelectValue /><Icon name="chevron" size={14} /></SelectTrigger
          >
          <SelectContent class="style-options" align="end"
            ><SelectItem value="all">All states</SelectItem><SelectItem
              value="available">Available</SelectItem
            ><SelectItem value="answering">Answering</SelectItem><SelectItem
              value="loading">Loading</SelectItem
            ><SelectItem value="paused">Paused</SelectItem><SelectItem
              value="offline">Offline</SelectItem
            ></SelectContent
          >
        </Select>
      </div>
      <div class="worker-table-wrap">
        <table class="worker-table">
          <caption class="sr-only"
            >Workers discovered by this browser. Metrics are self-reported.</caption
          >
          <thead
            ><tr
              ><th scope="col">Model / worker</th><th scope="col">State</th><th
                scope="col"
                class="numeric">Queue</th
              ><th scope="col" class="numeric">Last rate</th><th
                scope="col"
                class="numeric">Requests</th
              ><th scope="col"><span class="sr-only">Chat</span></th></tr
            ></thead
          >
          <tbody
            >{#each visible as member (member.id)}<tr>
                <td
                  ><div class="table-model">
                    <Icon
                      name={member.info.adapter.includes("2 devices")
                        ? "network"
                        : "device"}
                      size={18}
                    />
                    <div>
                      <strong>{name(member.info.model)}</strong><span
                        title={member.id}
                        >{shortId(member.id)}{member.id === selfId
                          ? " · This device"
                          : ""}</span
                      ><small>{member.info.adapter}</small>
                    </div>
                  </div></td
                >
                <td
                  ><span
                    class="state-pill"
                    class:busy={member.info.state === "busy" && !member.stale}
                    ><i
                      class="status-dot"
                      class:online={member.info.state === "idle" &&
                        !member.stale}
                    ></i>{workerStatus(member)}{typeof member.info.state ===
                      "object" && !member.stale
                      ? ` ${Math.round(member.info.state.loading.percent)}%`
                      : ""}</span
                  ></td
                >
                <td class="numeric">{format(member.info.waiting)}</td><td
                  class="numeric"
                  >{member.info.tokensPerSec > 0 && !member.stale
                    ? `${count(member.info.tokensPerSec).toFixed(1)} t/s`
                    : "—"}</td
                ><td class="numeric">{format(member.info.served)}</td>
                <td
                  ><Button
                    class="icon-button small"
                    aria-label={`Chat with ${name(member.info.model)}`}
                    disabled={!MODELS.some((m) => m.id === member.info.model) ||
                      member.stale ||
                      !["idle", "busy"].includes(String(member.info.state))}
                    onclick={() => onchat(member.info.model)}
                    ><Icon name="external" size={17} /></Button
                  ></td
                >
              </tr>{/each}</tbody
          >
        </table>
      </div>
      {#if !visible.length}<div class="dashboard-empty">
          <Icon name="network" size={28} /><strong
            >{members.length
              ? "No matching workers"
              : "No workers in view yet"}</strong
          >
          <p>
            {members.length
              ? "Try another search or state."
              : "Workers appear as peers connect. You can also share compute from this device."}
          </p>
          {#if members.length}<Button
              class="text-button"
              onclick={() => {
                query = "";
                filter = "all";
              }}>Clear filters</Button
            >{/if}
        </div>{/if}
      <div class="panel-footer">
        {visible.length} of {members.length} workers
        <span>Last rate = last completed request</span>
      </div>
    </section>

    <section class="dash-panel models-panel" aria-labelledby="models-title">
      <div class="panel-heading">
        <h2 id="models-title">Model availability</h2>
        <Icon name="grid" size={16} />
      </div>
      <div class="model-capacity-list">
        {#each models as model (model.id)}<div class="model-capacity">
            <div>
              <strong>{model.name}</strong><span
                >{model.ready
                  ? `${model.ready} available`
                  : model.workers
                    ? "Workers busy or preparing"
                    : "No workers"}</span
              >
            </div>
            <Button
              class="icon-button small"
              aria-label={`Choose ${model.name}`}
              disabled={!model.workers}
              onclick={() => onchat(model.id)}
              ><Icon name="external" size={17} /></Button
            >
            <div class="capacity-track" aria-hidden="true">
              <span
                style:width={`${model.workers ? (model.ready / model.workers) * 100 : 0}%`}
              ></span>
            </div>
            <small
              >{model.workers} worker{model.workers === 1
                ? ""
                : "s"}{model.shared
                ? " · Supports a two-device team"
                : " · Single-device model"}</small
            >
          </div>{/each}
      </div>
      <div class="panel-footer">A two-device team counts as one worker.</div>
    </section>

    <section class="dash-panel chart-panel" aria-labelledby="activity-title">
      <div class="panel-heading">
        <h2 id="activity-title">Request activity</h2>
        <div class="chart-legend">
          <span><i></i>Active</span><span><i></i>Queued</span>
        </div>
      </div>
      <div class="activity-chart">
        <div class="chart-scale"><span>{peak}</span><span>0</span></div>
        <svg
          viewBox="0 0 600 115"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Observed requests over ${history.samples.length} samples. Currently ${active} active and ${queued} queued.`}
        >
          <path class="chart-grid" d="M0 15H600M0 57.5H600M0 100H600" />
          {#if history.samples.length > 1}<polyline
              class="chart-line queue-line"
              points={queuePoints}
            /><polyline class="chart-line" {points} />{/if}
        </svg>
        {#if history.samples.length < 2}<span class="chart-collecting"
            >Collecting activity…</span
          >{/if}
      </div>
      <div class="chart-times">
        <span>{history.samples.length ? time(history.samples[0].at) : "—"}</span
        ><span>{latest ? time(latest) : "—"}</span>
      </div>
      <div class="panel-footer">
        Observed in this tab <span>Up to 3 minutes · 2-second samples</span>
      </div>
    </section>

    <section
      class="dash-panel connection-panel"
      aria-labelledby="connection-title"
    >
      <div class="panel-heading">
        <h2 id="connection-title">Connection</h2>
        <span class="panel-meta">IROH</span>
      </div>
      <dl class="connection-grid">
        <div>
          <dt>Connected peers</dt>
          <dd>{neighbors}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            {status === "connected"
              ? "Connected"
              : status === "error"
                ? "Failed"
                : "Finding peers"}
          </dd>
        </div>
        <div class="wide">
          <dt>Pool</dt>
          <dd>meshwebllm/pool/v1</dd>
        </div>
        <div class="wide">
          <dt>This device</dt>
          <dd class="endpoint-id">{selfId || "Connecting…"}</dd>
        </div>
      </dl>
      {#if error}<p class="dashboard-error">{error}</p>
        <Button class="button subtle reconnect" onclick={onretry}
          >Reconnect</Button
        >{/if}
      <div class="panel-footer">
        Peer connections include browsers here to chat.
      </div>
    </section>

    <section class="dash-panel events-panel" aria-labelledby="events-title">
      <div class="panel-heading">
        <h2 id="events-title">Recent activity</h2>
        <span class="panel-meta">THIS TAB SESSION</span>
      </div>
      <ol class="event-list">
        {#each history.events.slice(0, 12) as event (event.id)}<li>
            <time datetime={new Date(event.at).toISOString()}
              >{time(event.at)}</time
            ><span class="event-marker"></span><strong>{event.message}</strong
            ><span>{name(event.model)}</span><code>{shortId(event.worker)}</code
            >
          </li>{/each}
      </ol>
      {#if !history.events.length}<p class="activity-empty">
          Worker discoveries and state changes will appear here.
        </p>{/if}
    </section>
  </div>
  <p class="dashboard-note">
    Metrics are reported by workers currently in view, not lifetime pool totals.
    Availability can change when a browser closes or goes to sleep.
  </p>
</div>
