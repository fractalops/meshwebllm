import { chatCandidates, completeChat, type ChatNode } from "./chat-client.ts";
import type { ChatMessage, Member } from "./types.ts";

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "connecting" | "streaming" | "stopped" | "error";
  worker?: string;
  seconds?: number;
  tokens?: number;
  error?: string;
  prompt?: string;
}
export interface Conversation {
  id: string;
  title: string;
  model: string;
  draft: string;
  messages: Message[];
}
export interface ChatState {
  active: string;
  conversations: Conversation[];
  busy: boolean;
  announcement: string;
}
export class ChatStateController {
  private listeners = new Set<(state: ChatState) => void>();
  private run?: AbortController;
  private node?: ChatNode;
  private members: Member[] = [];
  state: ChatState;
  constructor(model: string) {
    const conversation = this.blank(model);
    this.state = {
      active: conversation.id,
      conversations: [conversation],
      busy: false,
      announcement: "",
    };
  }
  private blank(model: string): Conversation {
    return {
      id: crypto.randomUUID(),
      title: "New conversation",
      model,
      draft: "",
      messages: [],
    };
  }
  subscribe = (listener: (state: ChatState) => void) => {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<ChatState> = {}) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }
  get current() {
    return this.state.conversations.find(
      (item) => item.id === this.state.active,
    )!;
  }
  updateNetwork(node: ChatNode | undefined, members: Member[]) {
    this.node = node;
    this.members = members;
  }
  private edit(
    id: string,
    update: (conversation: Conversation) => Conversation,
  ) {
    this.publish({
      conversations: this.state.conversations.map((item) =>
        item.id === id ? update(item) : item,
      ),
    });
  }
  draft(text: string) {
    this.edit(this.state.active, (item) => ({ ...item, draft: text }));
  }
  newConversation(model = this.current.model) {
    this.stop();
    const empty = this.state.conversations.find(
      (item) => item.model === model && !item.messages.length && !item.draft,
    );
    const conversation = empty ?? this.blank(model);
    this.publish({
      active: conversation.id,
      conversations: empty
        ? this.state.conversations
        : [conversation, ...this.state.conversations],
      announcement: "New conversation",
    });
  }
  select(id: string) {
    if (
      !this.state.conversations.some((item) => item.id === id) ||
      id === this.state.active
    )
      return;
    this.stop();
    this.publish({ active: id, announcement: "Conversation opened" });
  }
  setModel(model: string) {
    if (model === this.current.model) return;
    if (this.current.messages.length) this.newConversation(model);
    else this.edit(this.state.active, (item) => ({ ...item, model }));
  }
  stop() {
    if (!this.run) return;
    this.run.abort();
    this.run = undefined;
    this.edit(this.state.active, (item) => ({
      ...item,
      messages: item.messages.map((m) =>
        m.status === "connecting" || m.status === "streaming"
          ? { ...m, status: "stopped" }
          : m,
      ),
    }));
    this.publish({ busy: false, announcement: "Reply stopped" });
  }
  async send(temperature = 0) {
    const conversation = this.current;
    const prompt = conversation.draft.trim();
    const candidates = chatCandidates(this.members, conversation.model);
    if (this.run || !prompt || !this.node || !candidates.length) return;
    const history: ChatMessage[] = [];
    for (let i = 0; i < conversation.messages.length - 1; i += 2) {
      const user = conversation.messages[i],
        reply = conversation.messages[i + 1];
      if (
        user.role === "user" &&
        reply.role === "assistant" &&
        reply.status === "complete"
      ) {
        history.push(
          { role: "User", content: user.text },
          { role: "Assistant", content: reply.text },
        );
      }
    }
    const run = new AbortController(),
      replyId = crypto.randomUUID(),
      started = performance.now();
    this.run = run;
    this.edit(conversation.id, (item) => ({
      ...item,
      title: item.messages.length ? item.title : prompt.slice(0, 70),
      draft: "",
      messages: [
        ...item.messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          text: prompt,
          status: "complete",
        },
        {
          id: replyId,
          role: "assistant",
          text: "",
          status: "connecting",
          prompt,
        },
      ],
    }));
    this.publish({ busy: true, announcement: "Connecting to a worker…" });
    const reply = (update: (message: Message) => Message) => {
      if (this.run !== run) return;
      this.edit(conversation.id, (item) => ({
        ...item,
        messages: item.messages.map((message) =>
          message.id === replyId ? update(message) : message,
        ),
      }));
    };
    try {
      const result = await completeChat(
        this.node,
        candidates,
        {
          messages: [...history, { role: "User", content: prompt }],
          max_tokens: 256,
          temperature,
        },
        run.signal,
        (worker) => reply((message) => ({ ...message, worker })),
        (chunk) =>
          reply((message) => ({
            ...message,
            text: message.text + chunk,
            status: "streaming",
          })),
      );
      if (this.run !== run) return;
      reply((message) => ({
        ...message,
        status: "complete",
        seconds: (performance.now() - started) / 1000,
        tokens: result.completion_tokens,
      }));
      this.publish({ announcement: "Reply complete" });
    } catch (error) {
      if (this.run !== run) return;
      reply((message) => ({
        ...message,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      this.publish({
        announcement:
          "Could not finish the reply. You can use the prompt again.",
      });
    } finally {
      if (this.run === run) {
        this.run = undefined;
        this.publish({ busy: false });
      }
    }
  }
}
