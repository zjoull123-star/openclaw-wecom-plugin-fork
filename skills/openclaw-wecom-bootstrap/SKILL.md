---
name: openclaw-wecom-bootstrap
description: Bootstrap the public WeCom OpenClaw plugin fork into another OpenClaw installation. Use when Codex needs to clone or update this GitHub repo, install or link the plugin, configure channels.wecom for multi-user auto-provision, optionally enable owner-only admin commands, validate the config, and restart the gateway.
---

# OpenClaw WeCom Bootstrap

Use `scripts/bootstrap-wecom-fork.sh` for the default path. It handles repo checkout, plugin install, config writes, validation, and restart.

## Workflow

1. Collect `botId` and `secret`.
2. Collect `owner` only if the user wants owner-only admin commands in WeCom.
3. Run the bootstrap script.
4. Verify plugin load, config validity, and channel health.

## Default Commands

Base install with open DM/group chat and auto-provision enabled:

```bash
bash scripts/bootstrap-wecom-fork.sh \
  --bot-id '<BOT_ID>' \
  --secret '<SECRET>'
```

Add an owner who can use `/config` and `/restart` from WeCom:

```bash
bash scripts/bootstrap-wecom-fork.sh \
  --bot-id '<BOT_ID>' \
  --secret '<SECRET>' \
  --owner 'LiaoLiang'
```

Enable owner shell commands only when the user explicitly wants `/bash` or `!` in WeCom:

```bash
bash scripts/bootstrap-wecom-fork.sh \
  --bot-id '<BOT_ID>' \
  --secret '<SECRET>' \
  --owner 'LiaoLiang' \
  --enable-owner-shell
```

## Safety Defaults

- Keep multi-user chat open by default.
- Keep `autoProvision` on by default.
- Keep owner shell access off unless the user explicitly requests it.
- When `--enable-owner-shell` is used, the script also sets `agents.defaults.elevatedDefault="off"` to reduce hidden exec-approval stalls in normal chat sessions.

Read `references/config-profiles.md` if the user asks what exact config keys change or why shell access is opt-in.

## Verification

Run these after the bootstrap script if the user wants an explicit health check:

```bash
openclaw plugins info wecom-openclaw-plugin
openclaw config validate
openclaw channels status --probe
openclaw config get channels.wecom --json
```

## Notes

- Prefer `--plugin-path` when the repo is already checked out locally.
- Prefer the default linked install; use `--copy-install` only if the user does not want a symlinked plugin checkout.
- The script merges `plugins.allow`, `commands.ownerAllowFrom`, and `tools.elevated.allowFrom.wecom` instead of overwriting those arrays.
- If the user wants a fully manual setup instead of the script, follow the profiles in `references/config-profiles.md` and apply them with `openclaw config set`.
