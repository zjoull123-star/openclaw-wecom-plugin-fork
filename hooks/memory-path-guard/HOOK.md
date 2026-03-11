---
name: memory-path-guard
description: "Block model tool writes into system-managed memory directories"
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "events": ["before_tool_call"],
        "requires": { "config": ["workspace.dir"] }
      },
  }
---

# Memory Path Guard

Prevents model tool calls from writing or editing files under `memory/`.

Behavior:
- blocks `write`, `edit`, and `exec` when the target path resolves into the current workspace `memory/`
- allows reads and searches
- tells the agent to use `notes/` for temporary scratch output instead
