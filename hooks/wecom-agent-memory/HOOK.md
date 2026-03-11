---
name: wecom-agent-memory
description: "Persist isolated long-term memory for WeCom DM and group agents"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["message:sent", "session:compact:after"],
        "requires": { "config": ["workspace.dir"] }
      },
  }
---

# WeCom Agent Memory

Keeps `memory/` inside each WeCom agent workspace in sync.

Behavior:
- every WeCom DM agent writes isolated memory into its own workspace
- every WeCom group agent writes isolated group memory into its own workspace
- `LiaoLiang -> main` keeps using `main` workspace memory
- no historical backfill; first sight sets a baseline and only later messages/compactions are written

It ignores approval codes, secrets, external links, transient command output,
queued messages, and one-off file paths.
