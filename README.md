# opencode-memory-agent

`opencode-memory-agent` is an **installable OpenCode plugin package** that recreates the core workflow of the Gemini always-on memory example using OpenCode plugins, the OpenCode SDK, and Bun-installed npm plugins.

It does four things out of the box:

1. watches high-signal OpenCode events such as `session.idle`,
2. captures durable session memory into `.opencode/memory/`,
3. consolidates stored memories into cross-session insights on a default 30-minute timer,
4. indexes project docs for later retrieval,
5. provides tools to inspect status, backfill older sessions, consolidate memory, and query the stored memory.

## Install into OpenCode

Add the package to your OpenCode plugin config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-memory-agent"]
}
```

If you want to pin a specific published version, use an npm-style package specifier:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-memory-agent@0.1.0"]
}
```

OpenCode installs npm plugins with Bun at startup, so users do **not** need to clone this repository manually.

## Configure the plugin

Project-level configuration lives in:

```text
.opencode/memory/config.json
```

Global user-level configuration can live in:

```text
~/.config/opencode/opencode-memory-agent.json
```

The plugin merges global config, optional `OPENCODE_MEMORY_AGENT_CONFIG`, and project config.

Example project config:

```json
{
  "debounceMs": 8000,
  "backfillOnStartup": false,
  "consolidateEveryMinutes": 30,
  "docs": {
    "enabled": true,
    "autoRefreshOnStartup": true,
    "autoRefreshOnEdit": true,
    "include": [
      "README.md",
      "AGENTS.md",
      "docs/**/*.md",
      "docs/**/*.mdx"
    ]
  }
}
```

## How to tell it is working

The plugin exposes custom tools:

- `memory_status` — shows storage paths, counts, and last-run metadata
- `memory_backfill` — processes existing sessions into memory
- `memory_consolidate` — builds cross-memory insights on demand
- `memory_query` — answers a question from stored memory and indexed docs
- `memory_refresh_docs` — rescans project docs

It also:

- writes structured logs through `client.app.log()`
- updates `.opencode/memory/private/status.json`
- writes memory entries to `.opencode/memory/shared/memories.json`
- writes consolidation insights to `.opencode/memory/shared/insights.json`
- optionally shows a toast when session memory is captured

## Back-process existing sessions

Ask OpenCode to run the `memory_backfill` tool, for example:

> Use the `memory_backfill` tool with a limit of 20 and refresh docs first.

That processes older sessions without requiring any repo-local bootstrap script.

## How this maps to the Gemini reference

The Gemini project runs as a 24/7 Python service that:

- ingests new inbox/API content immediately,
- auto-ingests dropped files within roughly 5–10 seconds,
- consolidates every 30 minutes by default,
- answers queries over both stored memories and consolidation insights.

This OpenCode plugin closes the closest equivalent gaps inside the OpenCode runtime:

- **ingest timing**: it captures memory after OpenCode activity becomes idle instead of watching an external inbox,
- **consolidation cadence**: it now runs a default **30-minute consolidation timer** while OpenCode is running,
- **manual consolidation**: `memory_consolidate` mirrors the Gemini project's explicit consolidate action,
- **prompt roles**: internal prompts are now split into **IngestAgent**, **ConsolidateAgent**, and **QueryAgent** roles.

Unlike the Gemini daemon, this plugin only runs while OpenCode is open, so `memory_backfill` and optional startup backfill help recover anything missed while OpenCode was not running.

## Project docs support

By default the plugin indexes common project docs such as:

- `README.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `docs/**/*.md`
- `docs/**/*.mdx`
- `.opencode/agents/**/*.md`

Indexed docs are stored in:

```text
.opencode/memory/shared/project-docs.json
```

## Repository development

This repository also contains:

- an Astro Starlight documentation site,
- CI and GitHub Pages workflows,
- example OpenCode config under `examples/project-template/`.

For local repository work:

```bash
npm install
npx playwright install --with-deps chromium
npm run validate
npm run dev
```
