import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/svelte/agent";
import { expect, test, vi, beforeEach } from "vitest";
import App from "./App.svelte";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  gpu: vi.fn(),
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
              model: "SmolLM2-135M-Instruct-ONNX-Q4",
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

test("sharing stays opt-in and the dialog returns focus when dismissed", async () => {
  render(App);
  await screen.findByText("1 worker available");
  const share = screen.getByRole("button", { name: "Share compute" });
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
  await userEvent.click(screen.getByRole("button", { name: "Share compute" }));
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
