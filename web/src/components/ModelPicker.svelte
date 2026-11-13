<script lang="ts">
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectItemText,
    SelectItemIndicator,
    SelectLabel,
    SelectTrigger,
    SelectValue,
  } from "@ui-sdk/svelte/select";
  import { MODELS } from "../config";
  import { chatCandidates } from "../chat-client";
  import type { Member } from "../types";
  import Icon from "./Icon.svelte";
  interface Props {
    value: string;
    members: Member[];
    onchange: (id: string) => void;
  }
  let { value, members, onchange }: Props = $props();
  const items = MODELS.map((model) => ({ value: model.id, label: model.name }));
</script>

<Select
  {value}
  {items}
  onValueChange={(next) => {
    if (typeof next === "string") onchange(next);
  }}
>
  <SelectLabel class="sr-only">Choose a model</SelectLabel>
  <SelectTrigger class="model-trigger"
    ><SelectValue /><Icon name="chevron" size={16} /></SelectTrigger
  >
  <SelectContent
    class="model-options"
    side="bottom"
    align="start"
    sideOffset={10}
  >
    <div class="popover-heading">
      Choose a model <span>Availability is live</span>
    </div>
    {#each MODELS as model (model.id)}
      <SelectItem value={model.id} class="model-option">
        <div>
          <SelectItemText class="option-title">{model.name}</SelectItemText
          ><span class="option-description">{model.description}</span><span
            class="option-availability"
            class:available={chatCandidates(members, model.id).length > 0}
            >{chatCandidates(members, model.id).length
              ? `${chatCandidates(members, model.id).length} available`
              : "No workers"}</span
          >
        </div>
        <SelectItemIndicator
          ><Icon name="check" size={18} /></SelectItemIndicator
        >
      </SelectItem>
    {/each}
    <p class="popover-footnote">Changing models starts a new conversation.</p>
  </SelectContent>
</Select>
