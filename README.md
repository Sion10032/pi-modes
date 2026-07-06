# 🧭 pi-modes — Plan/ReadOnly Mode for Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi extension that adds a Codex-like `/plan` collaboration mode and a minimal `/ro` read-only mode. Supports two-level tool config storage: project-level (`.pi/mode-tools.json`) and user-level (`~/.pi/mode-tools.json`).

## ✨ Features

### Plan Mode (`/plan`)

- Enter Plan mode for read-only exploration, clarifying questions, and a final `<proposed_plan>` block.
- Blocks mutating tools (`edit`, `write`, `rm`, `git commit`, etc.) while Plan mode is active.
- Injects Codex-like instructions: explore first, ask decision questions, finish with `<proposed_plan>`.
- Provides `plan_mode_question` tool for structured questions before finalizing a plan.
- Detects proposed plans and prompts you to implement, stay, or exit.
- Persists Plan mode state across session resumptions.

### Read-only Mode (`/ro`)

- Enter Read-only mode for safe code exploration without any modification risk.
- Blocks all mutating tools and bash commands.
- Shares the same tool safety strategies as Plan mode.

## 📦 Install

```bash
pi install npm:@sion10032/pi-modes
```

Try without installing permanently:

```bash
pi -e npm:@sion10032/pi-modes
```

## 🚀 Usage

### Plan Mode

```text
/plan              # Toggle Plan mode
/plan <prompt>     # Enter Plan mode and submit prompt
/plan tools        # Configure tools for Plan mode
/plan exit         # Exit Plan mode
```

When Plan mode is active:

- The agent explores code and asks decision questions via `plan_mode_question`.
- Mutating built-in tools and unsafe bash commands are blocked.
- Extension/custom tools are disabled by default; enable via `/plan tools` at your own risk.
- When the agent produces a `<proposed_plan>` block, you can implement, stay, or exit.

### Read-only Mode

```text
/ro                # Toggle Read-only mode
/ro <prompt>       # Enter Read-only mode and submit prompt
/ro tools          # Configure tools for Read-only mode
/ro exit           # Exit Read-only mode
```

## 🧠 Plan Mode Behavior

- Conversational collaboration, not TODO/progress tracking.
- Agent should explore first, then ask questions for high-impact ambiguity.
- Final plan appears as exactly one `<proposed_plan>` block:

```xml
<proposed_plan>
# Title

## Summary
...

## Key Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>
```

- After plan detection, `/plan` offers: implement, stay, or exit.
- Implementing restores full tools and starts implementation with the plan.
- Exiting discards the proposed plan.

## 🗂️ Package Layout

```txt
pi-modes/
├── src/
│   ├── index.ts              # Unified extension entry
│   ├── plan-mode.ts          # Plan mode logic
│   ├── readonly-mode.ts      # Read-only mode logic
│   └── shared/
│       ├── mode-types.ts     # Shared mode types
│       ├── tool-config.ts    # Configuration persistence
│       ├── tool-safety.ts    # Tool safety strategies
│       ├── tool-selector.ts  # Tool selection UI
│       ├── messages.ts       # Message utilities
│       ├── constants.ts      # Shared constants
│       └── types.ts          # Shared types
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, read-only mode, Codex-like plan mode, AI coding workflow.

## 🙏 Acknowledgments

This project is based on [@narumitw/pi-plan-mode](https://www.npmjs.com/package/@narumitw/pi-plan-mode) by [narumiruna](https://github.com/narumiruna/pi-extensions). Extended with shared mode guard, read-only mode, Chinese prompts, and unified configuration.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
