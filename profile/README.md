# WOPR Network

**87 public repos. Zero private.** Everything we build is open source. We make money running it so you don't have to.

---

## The Stack

### [WOPR](https://github.com/wopr-network/wopr) — Without Official Permission Required

Self-sovereign AI agent runtime. Install it, give it an API key, and it runs as a daemon managing persistent AI sessions with scheduling, context, and a plugin system. Through plugins, agents talk to Discord, Slack, Telegram, WhatsApp, Signal, Teams, IRC — or directly to each other over encrypted P2P. 50+ plugins, bring-your-own provider, bring-your-own channel.

WOPR is an employee. One agent, one identity, one set of channels.

### [Paperclip](https://github.com/wopr-network/paperclip) — Open-source orchestration for zero-human companies

If WOPR is an employee, Paperclip is the company. A Node.js server and React UI that orchestrates a team of AI agents to run a business. Org charts, budgets, governance, goal alignment, cost tracking, and agent coordination. It looks like a task manager — but under the hood every task traces back to a company mission, every agent has a boss and a budget, and every decision is auditable.

Define the goal. Hire the team. Hit go. If it can receive a heartbeat, it's hired.

### [Silo](https://github.com/wopr-network/silo) — Hope is not a gate

Flow engine and worker pool for agentic software engineering. You will deploy AI to write code. The question is how safely, at what speed, and at what cost.

Silo defines pipelines as state machines. At each state an agent does work. At each boundary a deterministic gate verifies the output — `tsc` either exits 0 or it doesn't. Agents get exactly two API calls: `claim` work, `report` results. The agent never decides what comes next. The engine does, based on evidence.

```
Vibe coding:  Human → AI → Hope → Production
Silo:         Human → AI → Gate → AI → Gate → AI → Gate → Production
```

For every 1 coder invocation there are ~2.8 reviewer/fixer invocations. That's not pipeline inefficiency. That's the actual shape of software.

### [NORAD](https://github.com/wopr-network/norad) — Pipeline dashboard

Real-time visibility into Silo. Entity lifecycle, activity feeds, gate outcomes. Watch agents claim, build, review, fix, and merge — or get stuck and flag for human intervention.

### [Nuke](https://github.com/wopr-network/nuke) — Agent containers

One container per agent invocation. An architect writes a spec and dies. A coder implements it and dies. A reviewer reads the diff and dies. The container does the work. Silo decides if the output earns escalation. Fork this repo to customize what's installed in your agent containers — a Python shop adds `pip` and `pytest`, a Rust shop adds `cargo` and `clippy`.

---

## Platform Layer

The hosting infrastructure is also open source.

| Repo | What |
|------|------|
| [wopr-platform](https://github.com/wopr-network/wopr-platform) | Fleet management, Docker orchestration, WOPR-as-a-Service |
| [paperclip-platform](https://github.com/wopr-network/paperclip-platform) | Paperclip hosting — auth, tenant routing, billing, reverse proxy |
| [platform-core](https://github.com/wopr-network/platform-core) | Shared SaaS infrastructure — auth, billing, tenant routing |
| [platform-ui-core](https://github.com/wopr-network/platform-ui-core) | Brand-agnostic UI — fleet management, lifecycle, observability |
| [provision-server](https://github.com/wopr-network/provision-server) | Embeddable router that makes any OSS project provisionable |
| [provision-client](https://github.com/wopr-network/provision-client) | Platform-side HTTP client and proxy middleware |

---

## Plugins

50+ plugins. All public.

**Channels:** Discord, Slack, Telegram, WhatsApp, Signal, IRC, Teams, Matrix, Mattermost, Reddit, Twitch, Twitter/X, Nostr, Google Chat, Feishu, LINE, iMessage, BlueBubbles, webhooks, web UI, voice calls

**Voice:** ElevenLabs, OpenAI TTS, Piper, Whisper, Deepgram, Chatterbox, Qwen3-TTS, VibeVoice

**Tools:** Browser, GitHub, MCP bridge, sandbox, web search, image/video gen, semantic memory, cron, Obsidian

---

## Philosophy

We open-source everything. The only things we keep private are runtime credentials. The `.env` file is the business. Everything else is just instructions for how to use it.

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
