# Domain language

- **Model**: a specific supported model export and runtime, identified by its exact model ID. Chat routes only to workers advertising that ID.
- **Worker**: one endpoint that accepts complete chat requests. It may run a whole model locally or coordinate a split team.
- **Contribution**: the lifecycle of donating this tab's compute: prepare, ready, generate, pause, stop. Chat does not require contributing.
- **Stage**: a contiguous range of transformer layers with its own GPU session and KV cache. A stage is not a complete-model worker.
- **Team**: one coordinator and one invited stage. The coordinator appears in the pool only as a logical full-model worker, ready after both stages load.
- **Model artifact**: a pinned model file, weight-free graph, manifest or content-addressed tensor chunk. Transport chunk boundaries do not define execution stages.
- **Pool**: signed worker discovery over iroh gossip. Presence is advisory; execution can still fail after a worker is selected.
