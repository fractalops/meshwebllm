import { render } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import Reply from "./Reply.svelte";

test("model output keeps formatting but cannot inject scripts, handlers, or remote images", () => {
  const { container } = render(Reply, {
    message: {
      id: "reply",
      role: "assistant",
      status: "complete",
      text: '**Readable**\n\n<script>alert(1)</script><img src="https://example.com/track" onerror="alert(1)"><a href="javascript:alert(1)" onclick="alert(1)">bad link</a>\n\n[Reference](https://example.com)',
    },
    model: "Test model",
    selfId: "local",
    onreuse: vi.fn(),
    oncopy: vi.fn(),
  });
  expect(container.querySelector("strong")?.textContent).toBe("Readable");
  expect(
    container.querySelector(
      'script, img, [onclick], [onerror], [href^="javascript:"]',
    ),
  ).toBeNull();
  expect(
    container.querySelector('a[href="https://example.com"]')?.textContent,
  ).toBe("Reference");
});
