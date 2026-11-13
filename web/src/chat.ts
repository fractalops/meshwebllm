import { chatCandidates, completeChat, type ChatNode } from "./chat-client";
import type { ModelSpec } from "./config";
import { type ChatMessage, type Member, shortId } from "./types";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
/** UI owns only draft/history/rendering. Routing and execution live below this interface. */
export class PoolChat {
  private history: ChatMessage[] = [];
  private run?: AbortController;
  private members: Member[] = [];
  private node?: ChatNode;
  private selfId = "";
  private follow = true;
  private revision = 0;
  private input = $<HTMLTextAreaElement>("chatInput");
  private transcript = $("chatMessages");
  constructor(private model: ModelSpec) {
    $("chatForm").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(this.input.scrollHeight, 150)}px`;
      this.controls();
    });
    $("chatStop").onclick = () => {
      this.run?.abort();
      $("chatStatus").textContent = "Stopping reply";
    };
    $("chatNew").onclick = () => this.clear();
    this.transcript.addEventListener("scroll", () => {
      this.follow =
        this.transcript.scrollHeight -
          this.transcript.scrollTop -
          this.transcript.clientHeight <
        60;
      $("chatLatest").hidden = this.follow;
    });
    $("chatLatest").onclick = () => {
      this.follow = true;
      this.scroll();
    };
    document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach(
      (button) =>
        (button.onclick = () => {
          this.input.value = button.dataset.prompt!;
          this.input.dispatchEvent(new Event("input"));
          this.input.focus();
        }),
    );
    this.controls();
  }
  setModel(model: ModelSpec) {
    if (this.model.id === model.id) return;
    this.model = model;
    this.clear();
  }
  clear() {
    this.revision++;
    this.run?.abort();
    this.history = [];
    this.transcript.replaceChildren();
    $("chatEmpty").hidden = false;
    $("chatTitle").textContent = "Start a conversation";
    $("chatStatus").textContent = "New chat";
    this.controls();
    this.input.focus();
  }
  update(node: ChatNode | undefined, members: Member[], selfId: string) {
    this.node = node;
    this.members = members;
    this.selfId = selfId;
    this.controls();
  }
  private controls() {
    const count = chatCandidates(this.members, this.model.id).length,
      busy = !!this.run;
    $("chatAvailability").textContent = !this.node
      ? "Connecting"
      : count
        ? `${count} worker${count === 1 ? "" : "s"} ready · auto`
        : "Waiting for a worker";
    $("emptyContribute").hidden = count > 0;
    $("chatEmptyHint").textContent = count
      ? "Choose a model. Send a message. The network finds a ready browser to answer."
      : "No browser is running this model yet. Contribute your GPU to start, or wait for a worker.";
    $<HTMLButtonElement>("chatSend").disabled =
      busy || !this.node || !count || !this.input.value.trim();
    $("chatSend").hidden = busy;
    $("chatStop").hidden = !busy;
  }
  private scroll() {
    if (this.follow) this.transcript.scrollTop = this.transcript.scrollHeight;
    $("chatLatest").hidden = this.follow;
  }
  private message(role: string, text: string) {
    const article = document.createElement("article");
    article.className = `chat-message ${role === "You" ? "chat-user" : "chat-assistant"}`;
    const label = document.createElement("div");
    label.className = "chat-role";
    label.textContent = role;
    const body = document.createElement("div");
    body.className = "chat-text";
    body.textContent = text;
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    article.append(label, body, meta);
    this.transcript.append(article);
    return { body, meta };
  }
  private async send() {
    const prompt = this.input.value.trim(),
      candidates = chatCandidates(this.members, this.model.id);
    if (this.run || !prompt || !this.node || !candidates.length) return;
    const run = new AbortController(),
      revision = this.revision;
    this.run = run;
    this.follow = true;
    $("chatEmpty").hidden = true;
    this.input.value = "";
    this.input.style.height = "auto";
    $("chatTitle").textContent =
      prompt.length > 55 ? prompt.slice(0, 55) + "…" : prompt;
    this.message("You", prompt);
    const reply = this.message(this.model.name, "");
    reply.body.classList.add("chat-pending");
    let text = "",
      worker = "";
    const started = performance.now();
    this.controls();
    this.scroll();
    try {
      const done = await completeChat(
        this.node,
        candidates,
        {
          messages: [...this.history, { role: "User", content: prompt }],
          max_tokens: 256,
          temperature: Number($<HTMLSelectElement>("temperature").value),
        },
        run.signal,
        (id) => {
          worker = id === this.selfId ? "This device" : shortId(id);
          reply.meta.textContent = `${worker} · connecting`;
          $("chatStatus").textContent = "Waiting for the worker";
        },
        (chunk) => {
          text += chunk;
          reply.body.classList.remove("chat-pending");
          reply.body.textContent = text;
          reply.meta.textContent = `${worker} · generating`;
          if (revision === this.revision) this.scroll();
        },
      );
      run.signal.throwIfAborted();
      if (revision !== this.revision) return;
      this.history.push(
        { role: "User", content: prompt },
        { role: "Assistant", content: text },
      );
      reply.meta.textContent = `${worker} · ${done.completion_tokens} tokens · ${((performance.now() - started) / 1000).toFixed(1)}s`;
      if (!text)
        reply.body.textContent =
          "The model ended its reply without text. Try a different prompt.";
      $("chatStatus").textContent = "Reply complete";
    } catch (error) {
      if (revision !== this.revision) return;
      const stopped = run.signal.aborted;
      reply.meta.textContent = stopped
        ? "Stopped · partial reply excluded from follow-ups"
        : error instanceof Error
          ? error.message
          : String(error);
      if (!text)
        reply.body.textContent = stopped
          ? "Reply stopped."
          : "Could not get a reply.";
      reply.meta.classList.toggle("bad", !stopped);
      $("chatStatus").textContent = stopped
        ? "Reply stopped"
        : "Request failed";
      const retry = document.createElement("button");
      retry.className = "chat-retry";
      retry.textContent = "Use prompt again";
      retry.onclick = () => {
        this.input.value = prompt;
        this.input.dispatchEvent(new Event("input"));
        this.input.focus();
      };
      reply.meta.append(" ", retry);
    } finally {
      reply.body.classList.remove("chat-pending");
      if (this.run === run) this.run = undefined;
      this.controls();
      if (revision === this.revision) this.scroll();
    }
  }
}
