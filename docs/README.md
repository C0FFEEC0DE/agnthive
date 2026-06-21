# Documentation

Start here, then follow the link that matches what you're doing.

| If you want to… | Read this |
|---|---|
| Install and use the profile | [`../README.md`](../README.md) · [`../claudecfg/GUIDE.md`](../claudecfg/GUIDE.md) |
| Understand how the hooks fit together | [`architecture.md`](architecture.md) |
| Spend fewer tokens | [`token-cost.md`](token-cost.md) |
| Run or extend the benchmarks | [`benchmarking.md`](benchmarking.md) |
| Add or tighten an agent | [`agent-contracts.md`](agent-contracts.md) · [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Review the coverage audit | [`audit-2026-06-21.md`](audit-2026-06-21.md) |
| Report a security issue | [`../SECURITY.md`](../SECURITY.md) |

## Layout

- `architecture.md` — the hook → state → gates → footer flow, with a diagram
- `token-cost.md` — six concrete levers for minimal token spend, each tied to the file that implements it
- `benchmarking.md` — benchmark runner contract, slot gate, and GitHub setup
- `agent-contracts.md` — the prompt ↔ hook ↔ benchmark contract matrix
- `audit-2026-06-21.md` — code-coverage audit: baseline (45.29% / 255 tests) through completion (100% / 648 tests)

User-facing cheatsheet lives at [`../claudecfg/GUIDE.md`](../claudecfg/GUIDE.md).