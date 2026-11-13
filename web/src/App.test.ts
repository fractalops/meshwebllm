import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/svelte/agent";
import { expect, test, vi, beforeEach } from "vitest";
import App from "./App.svelte";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  gpu: vi.fn(),
  workerModel: "SmolLM2-135M-Instruct-ONNX-Q4",
}));
const modelId = "SmolLM2-135M-Instruct-ONNX-Q4";
vi.mock("./mesh-session", () => ({
  MeshSession: {
    connect: async (changed: (peers: unknown[], count: number) => void) => {
      changed(
        [
          {
            id: "remote-worker",
            info: {
              model: mocks.workerModel,
              state: "idle",
              adapter: "Test GPU",
              waiting: 0,
              active: 0,
              served: 0,
              tokensOut: 0,
              tokensPerSec: 0,
              uptimeSecs: 0,
            },
            stale: false,
            firstSeenMs: 0,
            lastSeenMs: 0,
          },
        ],
        1,
      );
      return {
        node: { endpointId: () => "local-tab", complete: mocks.complete },
        close: mocks.close,
      };
    },
  },
}));
vi.mock("./contributor", () => ({
  checkGpu: () => mocks.gpu(),
  Contributor: class {
    running = false;
    canPause = false;
    isPaused = false;
    mode = "whole";
    model = undefined;
    invite = undefined;
    progress = { phase: "stopped", message: "" };
    info() {
      return undefined;
    }
    start = mocks.start;
    dispose() {
      return Promise.resolve();
    }
  },
}));
vi.mock("./runtime/split", () => ({
  readInvitation: () => undefined,
  invitationUrl: () => "",
}));
const agent = createAgent();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workerModel = modelId;
  history.replaceState(null, "", "/");
  mocks.gpu.mockResolvedValue({
    name: "Test GPU",
    onnxProblem: null,
    webllmProblem: null,
  });
  mocks.complete.mockImplementation(
    async () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue({ Chunk: { text: "The answer is **Paris**." } });
          controller.enqueue({
            Done: { model: modelId, prompt_tokens: 8, completion_tokens: 7 },
          });
          controller.close();
        },
      }),
  );
});

test("named SDK controls route a chat, render its reply, and keep it when starting another", async () => {
  render(App);
  await screen.findByText("1 worker available");
  const components = agent
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== "more");
  for (const entry of components)
    expect(entry.label, `${entry.component} has no name`).toBeTruthy();
  const labels = components.map((entry) => entry.label);
  for (const label of [
    "Choose a model",
    "Message the network",
    "Response style",
    "Send message",
  ])
    expect(labels).toContain(label);
  const filled = await agent.act({
    steps: [
      {
        ref: "Message the network",
        action: "setValue",
        args: ["What is the capital of France?"],
      },
    ],
  });
  expect(filled.ok).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Paris", { selector: "strong" });
  expect(mocks.complete.mock.calls[0][0]).toBe("remote-worker");
  await userEvent.click(
    screen.getAllByRole("button", { name: "New conversation" })[0],
  );
  expect(screen.queryByText("Paris", { selector: "strong" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "What is the capital of France?" }),
  );
  expect(screen.getByText("Paris", { selector: "strong" })).toBeTruthy();
});

test("chat sharing shortcut stays opt-in and returns focus when dismissed", async () => {
  render(App);
  await screen.findByText("1 worker available");
  const share = within(
    screen.getByRole("group", { name: "Chat shortcuts" }),
  ).getByRole("button", { name: "Share compute" });
  await userEvent.click(share);
  expect(
    await screen.findByRole("dialog", { name: "Put your browser to work." }),
  ).toBeTruthy();
  expect(mocks.start).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(share));
  await userEvent.click(share);
  await userEvent.click(screen.getByRole("button", { name: "Keep chatting" }));
  expect(mocks.start).not.toHaveBeenCalled();
  await userEvent.click(share);
  await userEvent.click(screen.getByRole("button", { name: "Start sharing" }));
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ id: modelId }),
    "whole",
  );
});

test("chat can connect while a GPU capability probe remains pending", async () => {
  mocks.gpu.mockImplementation(() => new Promise(() => {}));
  render(App);
  await screen.findByText("1 worker available");
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message the network" }),
    "Hello",
  );
  expect(
    (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("two-device sharing is an explicit selection", async () => {
  render(App);
  await screen.findByText("1 worker available");
  await userEvent.click(
    screen.getAllByRole("button", { name: "Share compute" })[0],
  );
  await userEvent.click(
    screen.getByRole("radio", { name: /With another device/ }),
  );
  await screen.findByText(/Splitting may be slower/);
  expect(mocks.start).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Start sharing" }));
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ id: modelId }),
    "shared",
  );
});

test("a worker for another model offers an explicit switch without losing the draft", async () => {
  mocks.workerModel = "SmolLM2-360M-Instruct-q4f16_1-MLC";
  render(App);
  await screen.findByRole("button", { name: "Network status: Connected" });
  expect(screen.getByText("No workers for this model")).toBeTruthy();
  expect(
    screen.getByText("SmolLM2 · 135M has no workers online."),
  ).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Message the network" });
  await userEvent.type(input, "What is the capital of France?");
  expect(
    (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "Use SmolLM2 · 360M" }),
  );
  expect((input as HTMLTextAreaElement).value).toBe(
    "What is the capital of France?",
  );
  expect(screen.getByText("1 worker available")).toBeTruthy();
  expect(new URLSearchParams(location.search).get("model")).toBe(
    mocks.workerModel,
  );
  expect(mocks.complete).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Paris", { selector: "strong" });
  expect(mocks.complete).toHaveBeenCalled();
});
