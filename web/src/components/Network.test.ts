import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Network from "./Network.svelte";
import { MODELS } from "../config";
import type { Member } from "../types";

const member = (id: string, state: "idle" | "busy", stale = false): Member => ({
  id,
  stale,
  firstSeenMs: 0,
  lastSeenMs: 0,
  info: {
    model: MODELS[0].id,
    state,
    adapter: "Test GPU",
    active: state === "busy" ? 1 : 0,
    waiting: 0,
    served: 3,
    tokensOut: 90,
    tokensPerSec: 12.2,
    uptimeSecs: 30,
  },
});
test("dashboard filters the real roster and routes an available model to chat", async () => {
  const onchat = vi.fn();
  render(Network, {
    members: [
      member("idle-worker", "idle"),
      member("busy-worker", "busy"),
      member("stale-worker", "busy", true),
    ],
    neighbors: 4,
    selfId: "local",
    status: "connected",
    error: "",
    history: { events: [], samples: [] },
    onchat,
    onretry: vi.fn(),
  });
  const metrics = screen.getByLabelText("Network metrics");
  expect(within(metrics).getByText("/ 2 online")).toBeTruthy();
  expect(screen.getByText(/6 completed · 180 tokens/)).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(4);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Find a worker" }),
    "busy-worker",
  );
  expect(screen.getAllByRole("row")).toHaveLength(2);
  await userEvent.clear(screen.getByRole("textbox", { name: "Find a worker" }));
  await userEvent.click(
    screen.getByRole("combobox", { name: "Filter workers by state" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "Available" }));
  expect(screen.getAllByRole("row")).toHaveLength(2);
  await userEvent.click(
    screen.getByRole("button", { name: `Chat with ${MODELS[0].name}` }),
  );
  expect(onchat).toHaveBeenCalledWith(MODELS[0].id);
});

test("worker details stay live and stop showing a departed worker as available", async () => {
  const worker = member("team-coordinator", "idle");
  worker.info.adapter = "Test GPU · 2 devices";
  const props = {
    members: [worker],
    neighbors: 1,
    selfId: "local",
    status: "connected",
    error: "",
    history: { events: [], samples: [] },
    onchat: vi.fn(),
    onretry: vi.fn(),
  };
  const { rerender } = render(Network, props);
  await userEvent.click(
    screen.getByRole("button", { name: "Inspect worker team-c…ator" }),
  );
  let dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Layers 0–14")).toBeTruthy();
  expect(within(dialog).getByText("Layers 15–29")).toBeTruthy();
  expect(
    within(dialog).getByText(/Individual stage health is not advertised/),
  ).toBeTruthy();
  await rerender({ ...props, members: [{ ...worker, stale: true }] });
  dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Offline")).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("button", { name: "Chat with this model" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await rerender({ ...props, members: [] });
  expect(
    within(screen.getByRole("dialog")).getByText("Worker left view"),
  ).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("full queues do not advertise model availability or enable chat", () => {
  const worker = member("full-worker", "idle");
  worker.info.waiting = 2;
  render(Network, {
    members: [worker],
    neighbors: 1,
    selfId: "local",
    status: "connected",
    error: "",
    history: { events: [], samples: [] },
    onchat: vi.fn(),
    onretry: vi.fn(),
  });
  expect(screen.getByText("Queue full")).toBeTruthy();
  expect(screen.getByText("No capacity right now")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: `Choose ${MODELS[0].name}` })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: `Chat with ${MODELS[0].name}` })
      .hasAttribute("disabled"),
  ).toBe(true);
});
