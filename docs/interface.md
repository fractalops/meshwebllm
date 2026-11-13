# Browser interface

The Svelte interface starts with a model picker and chat. Chat does not require WebGPU, a model download, or a contribution. Sharing compute is a separate, explicit action.

## State and lifecycle

- `App.svelte` starts the mesh session independently of the optional GPU probe, subscribes to the roster, and owns one contributor for the page.
- `chat-state.ts` keeps conversations in memory. Changing models preserves previous conversations. Reloading clears them. Completed exchanges become follow-up context; failed or stopped replies do not.
- Stop cancels the stream and releases the composer immediately. A late response cannot modify a newer request.
- Model selection uses exact runtime IDs. Network availability is advisory; the chat client tries another matching worker only before receiving reply text.
- `Contribution.svelte` offers whole-model sharing or the two-device experiment. The dialog shows download size and resource use before starting. The second stage joins only after accepting an invitation.

## Components and writing

Use per-component imports from `@ui-sdk/svelte` for interactive controls. The SDK supplies interaction and accessibility behavior; `style.css` supplies the appearance. Keep controls named, test keyboard focus, and honor reduced motion. The SDK is pinned to a beta version; upgrade it with interaction tests.

Replies support Markdown through marked and a DOMPurify allowlist. Images, scripts, event handlers, and unsafe URL schemes are excluded. Do not render raw worker output as HTML.

Keep the main flow in product terms: model, conversation, worker, and sharing. Protocol details belong in connection details. Do not imply that two devices guarantee faster inference or half the memory, or that the worker cannot read a request.

## Checks

`npm --prefix web test` runs transport/runtime tests and jsdom component tests. Component tests use the UI SDK agent surface and user interactions to check named controls, chat routing, session history, opt-in sharing, focus restoration, and output sanitization. `npm --prefix web run build` runs svelte-check before producing the deployment bundle.

Also check real browser inference, narrow layouts, keyboard model selection, cancellation, and sharing before release. jsdom does not validate GPU execution or layout.

As of 2026-11-13, npm audit reports two low-severity development-tool findings from the Svelte Vite plugin's deepmerge dependency, with no patched version available. There are no moderate, high, or critical findings in the current lockfile. Recheck this when upgrading the toolchain.

## Verification for 0.3.0

Local checks passed: 22 Node tests, six component/lifecycle tests, svelte-check with no errors or warnings, and the production build. A Chrome desktop chat received the Paris answer from an existing 360M worker over iroh. The 390 × 844 layout, mobile navigation, model selection, keyboard selection, and two-device sharing choices were checked in Chrome.

The runtime output-head transformation passed CPU numerical checks. Whole and split WebGPU execution with that transformation still need verification before deployment; browser control became unavailable during the final check. Earlier GPU checks in `runtime.md` cover the previous runtime, not this transformation.
