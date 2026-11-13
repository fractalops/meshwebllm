<script lang="ts">
  interface Props {
    name:
      | "grid"
      | "plus"
      | "chat"
      | "network"
      | "arrow"
      | "chevron"
      | "close"
      | "copy"
      | "check"
      | "menu"
      | "pause"
      | "stop"
      | "device"
      | "external"
      | "down";
    size?: number;
  }
  let { name, size = 20 }: Props = $props();
  const paths: Record<Props["name"], string> = {
    grid: "M5 5h14v14H5zM5 5l14 14M19 5L5 19",
    plus: "M12 5v14M5 12h14",
    chat: "M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z",
    network: "M5 5l14 2-3 12L5 5l-2 12 13 2M3 17 19 7",
    arrow: "M12 19V5m-6 6 6-6 6 6",
    chevron: "m8 10 4 4 4-4",
    close: "m6 6 12 12M18 6 6 18",
    copy: "M8 8h12v12H8zM16 4H4v12",
    check: "m5 12 4 4L19 6",
    menu: "M4 7h16M4 12h16M4 17h16",
    pause: "M8 5v14M16 5v14",
    stop: "M7 7h10v10H7z",
    device: "M3 4h18v13H3zM8 21h8m-4-4v4",
    external: "M7 17 17 7M7 7h10v10",
    down: "M12 5v14m-6-6 6 6 6-6",
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  ><path d={paths[name]} />{#if name === "grid"}<circle
      cx="5"
      cy="5"
      r="2"
      fill="currentColor"
    /><circle cx="19" cy="5" r="2" fill="currentColor" /><circle
      cx="5"
      cy="19"
      r="2"
      fill="currentColor"
    /><circle cx="19" cy="19" r="2" fill="currentColor" />{/if}</svg
>
