# Browser interface

The Svelte interface starts with a model picker and chat. Chat does not require WebGPU, a model download, or a contribution. Sharing compute is a separate, explicit action.

## State and lifecycle

- `App.svelte` starts the mesh session independently of the optional GPU probe, subscribes to the roster, and owns one contributor for the page.
- `chat-state.ts` keeps conversations in memory. Changing models preserves previous conversations. Reloading clears them. Completed exchanges become follow-up context; failed or stopped replies do not.
- Stop cancels the stream and releases the composer immediately. A late response cannot modify a newer request.
- Model selection uses exact runtime IDs. Network availability is advisory; the chat client tries another matching worker only before receiving reply text.
- `Contribution.svelte` offers whole-model sharing or the two-device experiment. The dialog shows download size and resource use before starting. The second stage joins only after accepting an invitation.

## Components and writing

Use per-component imports from `@ui-sdk/svelte` for interactive controls. The SDK supplies interaction and accessibility behavior; `style.css` supplies shared appearance and semantic color tokens; `network.css` styles the compute console. Keep controls named, test keyboard focus, and honor reduced motion. The SDK is pinned to a beta version; upgrade it with interaction tests.

The palette uses neutral black and charcoal surfaces with off-white controls. Green dots mean connected, live, or available. Busy workers use amber; paused, preparing, and offline states remain neutral. Accents are limited to small state indicators. The Network dashboard uses live roster data: worker availability, active/queued requests, reported completions and tokens, a searchable worker table, model capacity, and connection details. A bounded in-memory timeline records observed state changes and at most 90 load samples; it survives view changes within the tab. It does not infer connections between remote workers.

Replies support Markdown through marked and a DOMPurify allowlist. Images, scripts, event handlers, and unsafe URL schemes are excluded. Do not render raw worker output as HTML.

Keep the main flow in product terms: model, conversation, worker, and sharing. Protocol details belong in connection details. Do not imply that two devices guarantee faster inference or half the memory, or that the worker cannot read a request.

## Checks

`npm --prefix web test` runs transport/runtime tests and jsdom component tests. Component tests use the UI SDK agent surface and user interactions to check named controls, chat routing, session history, opt-in sharing, focus restoration, and output sanitization. `npm --prefix web run build` runs svelte-check before producing the deployment bundle.

Also check real browser inference, narrow layouts, keyboard model selection, cancellation, and sharing before release. jsdom does not validate GPU execution or layout.

As of 2026-11-13, npm audit reports two low-severity development-tool findings from the Svelte Vite plugin's deepmerge dependency, with no patched version available. There are no moderate, high, or critical findings in the current lockfile. Recheck this when upgrading the toolchain.

## Verification for 0.3.0

Local checks passed: 23 Node tests, seven component/lifecycle tests, svelte-check with no errors or warnings, and the production build. A Chrome desktop chat received the Paris answer from an existing 360M worker over iroh. The 390 × 844 layout, mobile navigation, model selection, keyboard selection, and two-device sharing choices were checked in Chrome. The final neutral interface and dashboard were also reviewed in the in-app browser at desktop and narrow widths; the worker table scrolls independently on phones. Search, model routing, and real completion activity were verified.

The runtime output-head transformation passed CPU numerical checks. The user also verified the optimized whole-model 135M path on their desktop: loading the model and asking for the capital of France produced a reply. The optimized split path was verified in two in-app browser tabs on the same Mac over public iroh relays: the Paris answer completed in 12.5 seconds (seven tokens). Stopping a streamed reply left the team usable; the next Paris request completed in 6.6 seconds. The host used the verified local source fixture, and the helper reused 148.9 MB of verified chunks. This check establishes GPU execution and recovery, not cross-device speedup.


## Network console (0.3.1)

The overview separates ready workers, running requests, queue depth, and available models. Model availability and chat actions use the same queue limits as the chat router. A worker can be online without being ready to accept a request.

The worker table is the primary workspace. Select a worker to open an accessible detail dialog with its reported device, model runtime, queue, counters, last generation rate, and observed activity. The dialog follows the live roster: stale workers become offline and departed workers show a departure state. Chat selects a worker for the model, not necessarily the row being inspected.

Two-device coordinators are identified by the existing publisher's ` · 2 devices` adapter suffix. The detail panel labels the diagram as worker-reported configuration. For the supported 135M split it shows layers 0–14 and 15–29; it does not invent the invited peer's ID or separate stage health. The protocol currently reports aggregate team status only.

Validation: 23 Node tests and nine component/lifecycle tests passed, including queue saturation and a selected worker going stale then disappearing. Svelte checks and the production build passed. The desktop and 390 × 844 phone layouts were reviewed with a live worker; the phone page has no horizontal overflow and the roster scrolls independently. Opening worker details and choosing chat produced a complete eight-token Paris reply from the existing 360M GPU worker over iroh. The inference runtime is unchanged in this UI release.
