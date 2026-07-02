# Token-cost optimization

The plugin reduces repeated coordination work without skipping verification.

- Specialist agents have narrow, role-specific prompts in `agents/`.
- Skills provide short, explicit task shapes instead of an always-loaded
  monolithic workflow.
- Handoffs use four fixed fields: `Outcome`, changed files, verification
  status, and remaining risks or next step. The hooks can validate this shape
  without follow-up repair dialogue.
- The stop gate ends repeated incomplete summaries after its bounded retry
  limit, preventing a policy-stall loop.
- Lifecycle logging is asynchronous and size-bounded; it does not add output
  to normal tool turns.

Cost is still controlled by the Claude Code model and effort settings selected
by the user. The plugin does not pin a model and does not modify global Claude
Code settings. Use the repository benchmark commands only when measuring agent
behavior; mock benchmarks require no model calls.
