# WOPR Network

**Open-source infrastructure for AI-native businesses.** 87 public repos. Zero private.

We build the stack that lets AI agents do real work — write code, run companies, talk to customers — with the safety rails that make it production-grade. Everything we build is open source. We make money hosting it so you don't have to.

---

## The Stack

### [Paperclip](https://github.com/wopr-network/paperclip) — Run a company with AI agents
Open-source orchestration for zero-human companies. Org charts, budgets, governance, goal alignment, and agent coordination — looks like a task manager, runs like a company. Built on [paperclipai/paperclip](https://github.com/paperclipai/paperclip) (MIT).

### [WOPR](https://github.com/wopr-network/wopr) — Multi-channel AI agent runtime
Self-sovereign AI session management with 50+ plugins. Discord, Slack, Telegram, WhatsApp, Signal, IRC, voice calls, and more. Persistent context, multi-provider support, P2P agent networking, and a full plugin ecosystem.

### [Silo](https://github.com/wopr-network/silo) — Agentic engineering pipeline
Flow engine and worker pool for AI-driven software development. Defines pipelines as state machines, enforces transitions with deterministic gates. Agents claim work, report results. The engine decides what happens next — based on evidence, not opinion. Hope is not a gate.

### [NORAD](https://github.com/wopr-network/norad) — Pipeline dashboard
Real-time visibility into the Silo pipeline. Entity lifecycle, activity feeds, agent status, gate outcomes.

### [Nuke](https://github.com/wopr-network/nuke) — Agent containers
Containerized discipline workers. One container per agent invocation — architect, coder, reviewer, fixer. RADAR launches them, NORAD watches them, Silo decides if their output earns escalation.

---

## Platform Layer

The hosting infrastructure is also open source.

| Repo | What |
|------|------|
| [wopr-platform](https://github.com/wopr-network/wopr-platform) | Fleet management, Docker orchestration, WaaS backend |
| [wopr-platform-ui](https://github.com/wopr-network/wopr-platform-ui) | Manifest-driven admin dashboard |
| [platform-core](https://github.com/wopr-network/platform-core) | Shared SaaS infrastructure — auth, billing, tenant routing |
| [platform-ui-core](https://github.com/wopr-network/platform-ui-core) | Brand-agnostic UI core — fleet management, lifecycle, observability |
| [paperclip-platform](https://github.com/wopr-network/paperclip-platform) | Paperclip hosting layer — auth, tenant routing, billing, reverse proxy |
| [provision-server](https://github.com/wopr-network/provision-server) | Embeddable router that makes any OSS project provisionable |
| [provision-client](https://github.com/wopr-network/provision-client) | Platform-side HTTP client and proxy middleware |

---

## Plugins

50+ plugins for channels, providers, voice, tools, and superpowers. All public, all MIT-compatible.

**Channels:** Discord, Slack, Telegram, WhatsApp, Signal, IRC, Teams, Matrix, Mattermost, Reddit, Twitch, Twitter/X, Nostr, Google Chat, Feishu, LINE, iMessage, BlueBubbles, webhooks, web UI, voice calls

**Providers:** Anthropic Claude, OpenAI, Kimi, OpenCode, Codex

**Voice:** ElevenLabs, OpenAI TTS, Piper, Whisper, Deepgram, Chatterbox, Qwen3-TTS, VibeVoice

**Tools:** Browser automation, GitHub, MCP bridge, sandbox execution, web search, image/video generation, semantic memory, cron scheduling

---

## Philosophy

We open-source everything. Every line of code, every platform component, every plugin. The only things we keep private are runtime credentials. The `.env` file is the business. Everything else is just instructions for how to use it.

Read more: [OSS_PHILOSOPHY.md](https://github.com/wopr-network/.github/blob/main/OSS_PHILOSOPHY.md)

---

## Progress

| Metric | Count |
|--------|-------|
| Total Issues | 2206 |
| Completed | 2139 |
| In Progress | 2 |
| Backlog | 65 |
| Completion | 97% |

![Burn-Up Chart](https://quickchart.io/chart/render/zf-3043ba88-8daa-4d1b-9a43-b145fb6d3d14)

![Velocity](https://quickchart.io/chart?c=%7B%22type%22%3A%22bar%22%2C%22data%22%3A%7B%22labels%22%3A%5B%22Feb%2010%2010%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Feb%2013%2013%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Feb%2016%2016%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Feb%2019%2019%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Feb%2022%2022%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Feb%2026%2001%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Mar%201%2004%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Mar%204%2007%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Mar%207%2010%3A00%22%2C%22%22%2C%22%22%2C%22%22%2C%22%22%2C%22Mar%2010%2014%3A00%22%2C%22%22%2C%22%22%2C%22%22%5D%2C%22datasets%22%3A%5B%7B%22label%22%3A%22Issues%20Closed%22%2C%22data%22%3A%5B1%2C0%2C8%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C5%2C4%2C6%2C0%2C0%2C1%2C0%2C0%2C1%2C0%2C0%2C0%2C7%2C0%2C5%2C1%2C0%2C5%2C4%2C8%2C13%2C12%2C3%2C8%2C6%2C12%2C0%2C4%2C6%2C4%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%5D%2C%22backgroundColor%22%3A%22%236366f1%22%7D%5D%7D%2C%22options%22%3A%7B%22title%22%3A%7B%22display%22%3Atrue%2C%22text%22%3A%22Velocity%20%E2%80%94%20Issues%20Closed%20per%20Hour%22%2C%22fontSize%22%3A16%7D%2C%22scales%22%3A%7B%22xAxes%22%3A%5B%7B%22ticks%22%3A%7B%22maxRotation%22%3A45%2C%22fontSize%22%3A10%7D%7D%5D%2C%22yAxes%22%3A%5B%7B%22ticks%22%3A%7B%22beginAtZero%22%3Atrue%2C%22stepSize%22%3A1%7D%2C%22scaleLabel%22%3A%7B%22display%22%3Atrue%2C%22labelString%22%3A%22Closed%22%7D%7D%5D%7D%2C%22legend%22%3A%7B%22display%22%3Afalse%7D%7D%7D&w=800&h=250&bkg=%23ffffff)

---

*Updated automatically every hour from [Linear](https://linear.app/wopr) — last run: 2026-03-12 17:07 UTC*
