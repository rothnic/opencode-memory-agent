# opencode-memory-agent

`opencode-memory-agent` is an **installable OpenCode plugin package** for persistent session
memory, cross-session insights, project-doc indexing, and verification tools inside OpenCode.

## Maintainer

- [Nick Roth](https://www.nickroth.com) — homepage
- [@rothnic](https://github.com/rothnic) — GitHub profile

It does five things out of the box:

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

- `memory_status` — shows configuration, runtime health, current background activity, last-run timestamps, generated artifact paths, recent generated examples, and verification guidance
- `memory_backfill` — processes existing sessions into memory
- `memory_consolidate` — builds cross-memory insights on demand
- `memory_query` — answers a question from stored memory and indexed docs
- `memory_refresh_docs` — rescans project docs

It also:

- writes structured logs through `client.app.log()`
- updates `.opencode/memory/private/status.json`
- stores shared memory in `.opencode/memory/shared/memory.db`
- mirrors memory entries to `.opencode/memory/shared/memories.json`
- mirrors consolidation insights to `.opencode/memory/shared/insights.json`
- optionally shows a toast when session memory is captured

The persisted status file now records:

- current activity such as `starting`, `waiting-for-idle`, `processing-session`, `backfilling`, `consolidating`, or `refreshing-docs`
- the configured cadence and toggles that affect background processing
- last run timestamps for memory capture, backfill, consolidation, and docs refresh
- runtime counters for queued/active/internal sessions
- the last error, if any

### Quick verification flow

1. Start OpenCode with the plugin enabled.
2. Work in a session until it goes idle.
3. Ask OpenCode to run `memory_status`.
4. Confirm:
   - health is `yes`,
   - current activity eventually returns to `idle`,
   - last memory capture is recent,
   - generated files exist under `.opencode/memory/`,
   - recent generated examples match your recent work.

### How to review what was generated

- open `.opencode/memory/shared/memory.db` for the primary shared memory store
- open `.opencode/memory/shared/memories.json` to inspect stored session summaries, facts, decisions, todos, and topics
- open `.opencode/memory/shared/insights.json` to inspect cross-session consolidation output
- open `.opencode/memory/shared/project-docs.json` to inspect indexed docs used during retrieval
- open `.opencode/memory/private/status.json` to inspect current health, last run, and background processing state

### How to tell whether retrieval is useful

Use `memory_query` to ask a question about known prior work and verify that the answer cites useful
`[Memory:*]`, `[Insight:*]`, or `[Doc:*]` evidence. Then use that result as context in a fresh task,
for example:

> Run `memory_query` for prior decisions about auth/session handling, summarize the answer, and use it before planning this task.

If retrieval is weak, stale, or uncited, run `memory_backfill`, `memory_consolidate`, or
`memory_refresh_docs` and compare the answer again.

## Back-process existing sessions

Ask OpenCode to run the `memory_backfill` tool, for example:

> Use the `memory_backfill` tool with a limit of 20 and refresh docs first.

That processes older sessions without requiring any repo-local bootstrap script.

## Gemini reference notes

The docs site includes a single reference page that summarizes the Gemini reference architecture and
the OpenCode-specific differences for this plugin.

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

If a session references readable local project files such as source files or config files, the
plugin also loads small excerpts from those files during memory extraction.

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
