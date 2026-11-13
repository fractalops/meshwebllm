<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Button } from "@ui-sdk/svelte/button";
  import { Textarea } from "@ui-sdk/svelte/textarea";
  import { Field, FieldLabel } from "@ui-sdk/svelte/field";
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
  } from "@ui-sdk/svelte/select";
  import {
    Dialog,
    DialogTrigger,
    DialogBackdrop,
    DialogContent,
    DialogTitle,
    DialogClose,
  } from "@ui-sdk/svelte/dialog";
  import { MODELS, SMOL_ID, initialModel } from "./config";
  import { Contributor, checkGpu, type GpuCheck } from "./contributor";
  import { MeshSession } from "./mesh-session";
  import { ChatStateController } from "./chat-state";
  import { chatCandidates } from "./chat-client";
  import {
    readInvitation,
    invitationUrl,
    type Invitation,
  } from "./runtime/split";
  import type { RuntimeProgress } from "./runtime/types";
  import type { Member } from "./types";
  import Icon from "./components/Icon.svelte";
  import ModelPicker from "./components/ModelPicker.svelte";
  import Reply from "./components/Reply.svelte";
  import Contribution from "./components/Contribution.svelte";
  import Network from "./components/Network.svelte";

  const chat = new ChatStateController(initialModel().id);
  let chatState = $state(chat.state);
  let view = $state(
    new URLSearchParams(location.search).get("view") === "network"
      ? "network"
      : "chat",
  );
  let mobileMenu = $state(false),
    temperature = $state<string | null>("0");
  let roster = $state<Member[]>([]),
    members = $state<Member[]>([]),
    neighbors = $state(0),
    selfId = $state("");
  let connection = $state("connecting"),
    connectionError = $state("");
  let gpu = $state<GpuCheck>(),
    gpuReady = $state(false),
    contributorReady = $state(false);
  let contribution = $state({
    running: false,
    canPause: false,
    paused: false,
    mode: "whole",
    model: "",
    invite: "",
    progress: { phase: "stopped", message: "" } as RuntimeProgress,
  });
  let invitation = $state<Invitation>(),
    joinPending = $state(false),
    notice = $state("");
  let feed = $state<HTMLElement>();
  let follow = $state(true),
    session = $state.raw<MeshSession>(),
    contributor = $state.raw<Contributor>();
  let disposed = false,
    connecting = false,
    noticeTimer: ReturnType<typeof setTimeout>;
  const current = $derived(
    chatState.conversations.find((item) => item.id === chatState.active)!,
  );
  const model = $derived(
    MODELS.find((item) => item.id === current.model) ?? MODELS[0],
  );
  const available = $derived(chatCandidates(members, model.id).length);
  const gpuProblem = $derived(
    !gpuReady
      ? "Checking this device’s GPU…"
      : model.runtime === "onnx"
        ? (gpu?.onnxProblem ?? null)
        : (gpu?.webllmProblem ?? null),
  );
  const status = $derived(
    connection === "error"
      ? "Connection failed"
      : connection === "connecting"
        ? "Connecting…"
        : neighbors
          ? "Connected"
          : "Finding peers…",
  );
  const suggestions = [
    {
      icon: "chat" as const,
      title: "Explain an idea",
      text: "Explain gravity in one sentence.",
    },
    {
      icon: "plus" as const,
      title: "Start a short note",
      text: "Write a one-sentence thank-you note to a friend.",
    },
    {
      icon: "grid" as const,
      title: "Ask a small question",
      text: "What is the capital of France?",
    },
  ];

  function toast(text: string) {
    clearTimeout(noticeTimer);
    notice = text;
    noticeTimer = setTimeout(() => (notice = ""), 6000);
  }
  async function copy(text: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Clipboard unavailable")),
            2000,
          );
        }),
      ]);
      toast("Copied to clipboard.");
      return true;
    } catch {
      toast("Could not copy automatically. Select the text and copy it.");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  function sync() {
    const info = contributor?.info();
    members =
      info && session
        ? [
            {
              id: selfId,
              info,
              firstSeenMs: contributor!.startedAt,
              lastSeenMs: Date.now(),
              stale: false,
            },
            ...roster.filter((member) => member.id !== selfId),
          ]
        : [...roster];
    if (contributor)
      contribution = {
        running: contributor.running,
        canPause: contributor.canPause,
        paused: contributor.isPaused,
        mode: contributor.mode,
        model: contributor.model?.name ?? "",
        invite: contributor.invite ? invitationUrl(contributor.invite) : "",
        progress: { ...contributor.progress },
      };
    chat.updateNetwork(session?.node, members);
  }
  function createContributor() {
    if (!session || !gpuReady || contributor || disposed) return;
    contributor = new Contributor(
      session.node,
      gpu?.name ?? "Browser GPU",
      sync,
    );
    contributorReady = true;
    sync();
  }
  async function connect() {
    if (connecting || disposed) return;
    connecting = true;
    connection = "connecting";
    connectionError = "";
    try {
      const next = await MeshSession.connect((peers, count) => {
        if (disposed) return;
        roster = peers;
        neighbors = count;
        connection = count ? "connected" : "discovering";
        sync();
      });
      if (disposed) {
        await next.close();
        return;
      }
      session = next;
      selfId = next.node.endpointId();
      connection = neighbors ? "connected" : "discovering";
      createContributor();
      sync();
    } catch (error) {
      connection = "error";
      connectionError = error instanceof Error ? error.message : String(error);
    } finally {
      connecting = false;
    }
  }
  function navigate(next: string) {
    view = next;
    mobileMenu = false;
    const url = new URL(location.href);
    if (next === "network") url.searchParams.set("view", "network");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
  }
  function setModel(id: string) {
    if (!MODELS.some((model) => model.id === id)) return;
    chat.setModel(id);
    const url = new URL(location.href);
    url.searchParams.set("model", id);
    history.replaceState(null, "", url);
  }
  function newChat() {
    chat.newConversation();
    follow = true;
    navigate("chat");
  }
  function openConversation(id: string) {
    chat.select(id);
    follow = true;
    navigate("chat");
  }
  function usePrompt(prompt: string) {
    chat.draft(prompt);
    navigate("chat");
    void tick().then(() => document.getElementById("message-input")?.focus());
  }
  function send() {
    follow = true;
    void chat.send(Number(temperature));
  }
  function keydown(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      matchMedia("(pointer: fine)").matches
    ) {
      event.preventDefault();
      send();
    }
  }
  function scroll() {
    if (!feed) return;
    follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  }
  function latest() {
    follow = true;
    feed?.scrollTo({ top: feed.scrollHeight, behavior: "instant" });
  }
  function start(mode: "whole" | "shared") {
    void contributor?.start(model, mode).catch((error) => toast(String(error)));
  }
  async function stop() {
    await contributor?.stop().catch((error) => toast(String(error)));
  }
  function loadInvitation() {
    invitation = undefined;
    try {
      invitation = readInvitation(location.hash);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }
  function dismissInvitation() {
    invitation = undefined;
    history.replaceState(null, "", location.pathname + location.search);
  }
  function join() {
    if (
      !invitation ||
      !contributor ||
      !gpuReady ||
      gpu?.onnxProblem ||
      contribution.running
    )
      return;
    const invite = invitation;
    joinPending = true;
    setModel(SMOL_ID);
    dismissInvitation();
    void contributor
      .start(MODELS[0], "helper", invite)
      .catch((error) => toast(String(error)))
      .finally(() => (joinPending = false));
  }
  $effect(() => {
    const text = current.messages.at(-1)?.text;
    const length = current.messages.length;
    void text;
    void length;
    if (follow && feed)
      void tick().then(() => {
        if (follow && feed) feed.scrollTop = feed.scrollHeight;
      });
  });
  onMount(() => {
    const unsubscribe = chat.subscribe((state) => (chatState = state));
    void connect();
    let gpuTimer: ReturnType<typeof setTimeout>;
    void Promise.race([
      checkGpu(),
      new Promise<never>((_, reject) => {
        gpuTimer = setTimeout(
          () => reject(new Error("GPU check timed out")),
          8000,
        );
      }),
    ])
      .then((result) => {
        if (!disposed) gpu = result;
      })
      .catch(() => {
        if (!disposed)
          gpu = {
            name: "GPU unavailable",
            onnxProblem:
              "This browser cannot share its GPU. You can still chat using a network worker.",
            webllmProblem:
              "This browser cannot share its GPU. You can still chat using a network worker.",
          };
      })
      .finally(() => {
        clearTimeout(gpuTimer);
        if (!disposed) {
          gpuReady = true;
          createContributor();
        }
      });
    loadInvitation();
    const close = () => {
      if (disposed) return;
      disposed = true;
      chat.stop();
      void contributor?.dispose();
      void session?.close();
    };
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("hashchange", loadInvitation);
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", resume);
    return () => {
      unsubscribe();
      clearTimeout(noticeTimer);
      clearTimeout(gpuTimer);
      close();
      window.removeEventListener("hashchange", loadInvitation);
      window.removeEventListener("pagehide", close);
      window.removeEventListener("pageshow", resume);
    };
  });
</script>

{#snippet sidebar()}
  <a class="brand" href="./" aria-label="meshwebllm home"
    ><Icon name="grid" size={29} /><span>meshwebllm</span><span
      class="preview-dot"
      title="Preview"
    ></span></a
  >
  <Button class="button new-chat" onclick={newChat}
    ><Icon name="plus" size={18} />New conversation<span
      class="new-chat-symbol"
      aria-hidden="true">↗</span
    ></Button
  >
  <nav class="sidebar-nav" aria-label="Main navigation">
    <Button
      class={`nav-item ${view === "chat" ? "active" : ""}`}
      aria-current={view === "chat" ? "page" : undefined}
      onclick={() => navigate("chat")}
      ><Icon name="chat" size={18} />Chat</Button
    >
    <Button
      class={`nav-item ${view === "network" ? "active" : ""}`}
      aria-current={view === "network" ? "page" : undefined}
      onclick={() => navigate("network")}
      ><Icon name="network" size={18} />Network<span class="nav-count"
        >{members.filter((member) => !member.stale).length}</span
      ></Button
    >
  </nav>
  <div class="session-chats">
    <span class="section-label">THIS SESSION</span
    >{#if chatState.conversations.some((item) => item.messages.length)}<div
        class="conversation-links"
      >
        {#each chatState.conversations.filter((item) => item.messages.length) as conversation (conversation.id)}<Button
            class={`conversation-link ${conversation.id === current.id && view === "chat" ? "selected" : ""}`}
            onclick={() => openConversation(conversation.id)}
            title={conversation.title}>{conversation.title}</Button
          >{/each}
      </div>{:else}<p>Your conversations will appear here.</p>{/if}
  </div>
  <div class="sidebar-bottom">
    <Contribution
      {model}
      progress={contribution.progress}
      running={contribution.running}
      canPause={contribution.canPause}
      paused={contribution.paused}
      mode={contribution.mode}
      invite={contribution.invite}
      contributingModel={contribution.model}
      problem={gpuProblem}
      connected={contributorReady}
      onstart={start}
      onstop={stop}
      onpause={() => contributor?.pause()}
      oncopy={copy}
    />
    <div class="sidebar-footer">
      <span
        >Connected by <a
          href="https://www.iroh.computer/"
          target="_blank"
          rel="noreferrer">iroh</a
        ></span
      ><a
        href="https://github.com/fractalops/meshwebllm"
        aria-label="View source on GitHub"
        target="_blank"
        rel="noreferrer"><Icon name="external" size={17} /></a
      >
    </div>
  </div>
{/snippet}
<a class="skip-link" href="#main">Skip to conversation</a>
<div class="app-shell">
  <aside class="sidebar desktop-sidebar">{@render sidebar()}</aside>
  <main id="main" class="main-panel" tabindex="-1">
    <header class="topbar">
      <div class="mobile-navigation">
        <Dialog bind:open={mobileMenu}
          ><DialogTrigger class="icon-button" aria-label="Open navigation"
            ><Icon name="menu" /></DialogTrigger
          ><DialogBackdrop class="dialog-backdrop" /><DialogContent
            class="navigation-drawer"
            initialFocus="content"
            ><DialogTitle class="sr-only">Navigation</DialogTitle><DialogClose
              class="icon-button drawer-close"
              aria-label="Close navigation"><Icon name="close" /></DialogClose
            >
            <div class="sidebar">{@render sidebar()}</div></DialogContent
          ></Dialog
        >
      </div>
      {#if view === "chat"}<ModelPicker
          value={model.id}
          {members}
          onchange={setModel}
        />{:else}<span class="topbar-title">Network</span>{/if}
      <div class="topbar-end">
        <span class="preview-label">PREVIEW</span><Button
          class="connection-button"
          onclick={() => navigate(view === "network" ? "chat" : "network")}
          aria-label={`Network status: ${status}`}
          ><span
            class="status-dot"
            class:online={connection === "connected"}
            class:failed={connection === "error"}
          ></span><span>{status}</span></Button
        ><Button
          class="icon-button mobile-new"
          onclick={newChat}
          aria-label="New conversation"><Icon name="plus" /></Button
        >
      </div>
    </header>
    {#if invitation}<div class="invitation-banner">
        <Icon name="network" />
        <div>
          <strong>You’ve been invited to share a model.</strong>
          <p>
            {contribution.running
              ? "Stop your current contribution before joining this team."
              : gpuReady && gpu?.onnxProblem
                ? gpu.onnxProblem
                : "This device will run half the layers. Join only if you trust the sender."}
          </p>
        </div>
        <Button
          class="button primary"
          disabled={!contributorReady ||
            !!gpu?.onnxProblem ||
            contribution.running ||
            joinPending}
          onclick={join}>Join team</Button
        ><Button
          class="icon-button"
          aria-label="Dismiss invitation"
          onclick={dismissInvitation}><Icon name="close" /></Button
        >
      </div>{/if}
    {#if view === "network"}<Network
        {members}
        {neighbors}
        {selfId}
        status={connection}
        error={connectionError}
        onchat={(id) => {
          setModel(id);
          navigate("chat");
        }}
        onretry={() => void connect()}
      />
    {:else}
      <div class="chat-area" class:has-messages={current.messages.length > 0}>
        <div class="conversation-scroll" bind:this={feed} onscroll={scroll}>
          {#if !current.messages.length}
            <section class="welcome">
              <div class="welcome-mark"><Icon name="grid" size={42} /></div>
              <span class="eyebrow">A LITTLE COMPUTE, SHARED.</span>
              <h1>What’s on your mind?</h1>
              <p>Choose a model. A browser on the network will answer.</p>
            </section>
          {:else}
            <div class="transcript" aria-label="Conversation">
              <h1 class="sr-only">{current.title}</h1>
              {#each current.messages as message (message.id)}<Reply
                  {message}
                  model={model.name}
                  {selfId}
                  onreuse={usePrompt}
                  oncopy={copy}
                />{/each}
            </div>
          {/if}
        </div>
        <div class="composer-region">
          {#if !follow && current.messages.length}<Button
              class="jump-latest button subtle"
              onclick={latest}
              ><Icon name="down" size={15} />Latest reply</Button
            >{/if}
          {#if !current.messages.length}<div class="suggestions">
              {#each suggestions as suggestion (suggestion.title)}<Button
                  class="suggestion"
                  onclick={() => usePrompt(suggestion.text)}
                  ><Icon name={suggestion.icon} size={18} /><span
                    >{suggestion.title}</span
                  ><Icon name="external" size={15} /></Button
                >{/each}
            </div>{/if}
          <form
            class="composer"
            onsubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <Field name="message"
              ><FieldLabel class="sr-only">Message the network</FieldLabel
              ><Textarea
                id="message-input"
                value={current.draft}
                onValueChange={(value) => chat.draft(value)}
                onkeydown={keydown}
                placeholder="Ask a question…"
                autocomplete="off"
                autoResize
                rows={2}
                maxlength={12000}
              /></Field
            >
            <div class="composer-toolbar">
              <span class="availability"
                ><span class="status-dot" class:online={available > 0}
                ></span>{connection === "error"
                  ? "Connection failed"
                  : !session
                    ? "Connecting…"
                    : available
                      ? `${available} worker${available === 1 ? "" : "s"} available`
                      : "Waiting for a worker"}</span
              >
              <div class="composer-actions">
                <Select
                  bind:value={temperature}
                  items={[
                    { value: "0", label: "Precise" },
                    { value: "0.7", label: "Creative" },
                  ]}
                  ><SelectLabel class="sr-only">Response style</SelectLabel
                  ><SelectTrigger class="style-trigger"
                    ><SelectValue /><Icon
                      name="chevron"
                      size={14}
                    /></SelectTrigger
                  ><SelectContent
                    class="style-options"
                    side="top"
                    align="end"
                    sideOffset={10}
                    ><SelectItem value="0">Precise</SelectItem><SelectItem
                      value="0.7">Creative</SelectItem
                    ></SelectContent
                  ></Select
                >{#if chatState.busy}<Button
                    class="send-button stopping"
                    aria-label="Stop reply"
                    onclick={() => chat.stop()}
                    ><Icon name="stop" size={18} /></Button
                  >{:else}<Button
                    type="submit"
                    class="send-button"
                    aria-label="Send message"
                    disabled={!current.draft.trim() || !available || !session}
                    ><Icon name="arrow" size={20} /></Button
                  >{/if}
              </div>
            </div>
          </form>
          <div class="composer-caption">
            <span
              >{model.id === SMOL_ID
                ? "A small experimental model. Keep prompts short."
                : "Models can make mistakes. Check important answers."}</span
            ><span class="keyboard-hint"
              >Enter to send · Shift + Enter for a new line</span
            >
          </div>
          {#if !available && connection !== "connecting"}<p
              class="availability-help"
            >
              {connection === "error"
                ? "Open Network to reconnect."
                : "Try another model, or share compute from a supported device."}
            </p>{/if}
          <p class="privacy-note">
            The worker can read your messages. Conversations stay in this tab.
          </p>
        </div>
      </div>
    {/if}
  </main>
</div>
<div class="sr-only" aria-live="polite" aria-atomic="true">
  {chatState.announcement}
</div>
{#if notice}<div class="toast" role="status">
    {notice}<Button
      class="icon-button small"
      aria-label="Dismiss notification"
      onclick={() => (notice = "")}><Icon name="close" size={15} /></Button
    >
  </div>{/if}
