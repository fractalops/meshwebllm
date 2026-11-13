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
  expect(within(metrics).getByText("180")).toBeTruthy();
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
