<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { Button } from "@ui-sdk/svelte/button";
  import type { Message } from "../chat-state";
  import { shortId } from "../types";
  import Icon from "./Icon.svelte";
  interface Props {
    message: Message;
    model: string;
    selfId: string;
    onreuse: (prompt: string) => void;
    oncopy: (text: string) => Promise<boolean>;
  }
  let { message, model, selfId, onreuse, oncopy }: Props = $props();
  let copied = $state(false);
  const html = $derived(
    DOMPurify.sanitize(
      marked.parse(message.text, { async: false, breaks: true }),
      {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "em",
          "del",
          "code",
          "pre",
          "ul",
          "ol",
          "li",
          "blockquote",
          "h1",
          "h2",
          "h3",
          "h4",
          "hr",
          "a",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
        ],
        ALLOWED_ATTR: ["href", "title", "start"],
      },
    ),
  );
  async function copy() {
    copied = await oncopy(message.text);
  }
</script>

<article
  class:user-message={message.role === "user"}
  class:assistant-message={message.role === "assistant"}
>
  {#if message.role === "user"}<span class="sr-only">You</span>
    <div class="user-text">{message.text}</div>
  {:else}
    <div class="reply-label">
      <span class="reply-mark"><Icon name="grid" size={17} /></span>{model}<span
        class="reply-origin">via the network</span
      >
    </div>
    {#if message.text}<div class="prose">{@html html}</div>
    {:else if message.status === "connecting"}<div class="reply-pending">
        <span class="pulse-dot"></span>Connecting to a worker…
      </div>
    {:else if message.status === "complete"}<p class="reply-notice">
        The model ended without a reply. Try a shorter prompt.
      </p>
    {:else if message.status === "stopped"}<p class="reply-notice">
        Reply stopped.
      </p>
    {:else if message.status === "error"}<p class="reply-notice">
        The worker could not finish this reply.
      </p>{/if}
    {#if message.status === "streaming"}<div
        class="stream-indicator"
        aria-label="Writing reply"
      >
        <span></span><span></span><span></span>
      </div>{/if}
    {#if message.status === "error"}<p class="inline-error">
        {message.error}
      </p>{/if}
    {#if message.status === "stopped" || message.status === "error"}<div
        class="reply-recovery"
      >
        <span
          >{message.status === "stopped"
            ? "Stopped. This reply won’t be used in follow-ups."
            : "Your prompt is saved."}</span
        ><Button
          class="text-button"
          onclick={() => onreuse(message.prompt ?? "")}>Use prompt again</Button
        >
      </div>{/if}
    {#if message.status === "complete" || message.status === "stopped"}
      <div class="reply-actions">
        {#if message.text}<Button
            class="icon-button small"
            aria-label={copied ? "Reply copied" : "Copy reply"}
            onclick={copy}
            ><Icon name={copied ? "check" : "copy"} size={16} /></Button
          >{/if}
        {#if message.seconds !== undefined}<span
            >{message.seconds.toFixed(1)}s · {message.tokens} tokens</span
          >{/if}
        {#if message.worker}<span class="worker-source"
            >{message.worker === selfId
              ? "This device"
              : shortId(message.worker)}</span
          >{/if}
      </div>
    {/if}
  {/if}
</article>
