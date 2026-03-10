# WeCom OpenClaw Plugin Fork

Patched WeCom channel plugin for [OpenClaw](https://github.com/openclaw).

This fork adds:

- WeCom long-connection bot access
- Auto-provisioned per-user DM agents and workspaces
- Auto-provisioned per-group agents with mention-only activation
- Owner-only high-risk commands for `/config set`, `/config unset`, `/restart`, `/approve`, `/activation`, `!`, and `/bash`
- WeCom-scoped media intake with `20MB` PDF/file support and `7`-day retention
- WeCom exec approval delivery to designated admin DMs

This repository is intended for Git-based installs. It is not published as a separate npm package. If you run `openclaw plugins install @wecom/wecom-openclaw-plugin`, you will get the upstream package, not this fork.

## Install This Fork

Recommended workflow:

```sh
git clone https://github.com/zjoull123-star/openclaw-wecom-plugin-fork.git
openclaw plugins install --link /absolute/path/to/openclaw-wecom-plugin-fork
```

Use `--link` if you want the installed plugin to keep tracking your local checkout. That is the simplest setup for a fork.

For a copy install instead of a symlinked install:

```sh
git clone https://github.com/zjoull123-star/openclaw-wecom-plugin-fork.git
openclaw plugins install /absolute/path/to/openclaw-wecom-plugin-fork
```

Recommended trust config after install:

```sh
openclaw config set plugins.allow '["wecom-openclaw-plugin"]'
```

## Bootstrap Skill

This repo also includes a Codex skill at:

```text
skills/openclaw-wecom-bootstrap
```

Use that skill when another Codex instance needs to:

- clone or update this fork
- install or link the plugin into OpenClaw
- apply the multi-user WeCom auto-provision config
- optionally enable owner-only admin commands
- validate config and restart the gateway

## Minimal Channel Setup

```sh
openclaw config set channels.wecom.botId <BOT_ID>
openclaw config set channels.wecom.secret <SECRET>
openclaw config set channels.wecom.enabled true
openclaw gateway restart
```

## Multi-User Auto-Provision Setup

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "open",
      "media": {
        "maxMb": 20,
        "retentionDays": 7,
        "storageDir": "~/.openclaw/media/wecom"
      },
      "approvals": {
        "enabled": true,
        "notifyTo": ["LiaoLiang"],
        "dmOnly": true
      },
      "autoProvision": {
        "enabled": true,
        "registryPath": "~/.openclaw/credentials/wecom-auto-agents.json",
        "templateDir": "~/.openclaw/templates/wecom-default-agent",
        "dm": {
          "agentIdPrefix": "wecom-dm",
          "workspaceRoot": "~/.openclaw/workspace-wecom/dm"
        },
        "group": {
          "agentIdPrefix": "wecom-group",
          "workspaceRoot": "~/.openclaw/workspace-wecom/group",
          "requireMention": true
        }
      }
    }
  },
  "commands": {
    "ownerAllowFrom": ["wecom:LiaoLiang"]
  },
  "plugins": {
    "allow": ["wecom-openclaw-plugin"]
  },
  "tools": {
    "elevated": {
      "allowFrom": {
        "wecom": ["LiaoLiang"]
      }
    }
  }
}
```

Behavior:

- Each DM `userid` gets one persistent top-level agent and one workspace.
- Each group `chatid` gets one persistent group agent.
- Group auto-provision only happens when the bot is mentioned.
- `main` remains the default local CLI/App agent.
- High-risk commands stay restricted to `commands.ownerAllowFrom`; `!` and `/bash` also require `tools.elevated.allowFrom.wecom`.
- Inbound files are stored under `channels.wecom.media.storageDir`, pruned after `retentionDays`, and only accepted up to `maxMb`.
- Approval requests raised by WeCom sessions are sent to `approvals.notifyTo` as DM messages, and `/approve <id> allow-once|allow-always|deny` is only accepted from those admins.

## Template Seeding

On first use, the plugin seeds `~/.openclaw/templates/wecom-default-agent` from the current default workspace starter files:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `skills/`

New WeCom workspaces are copied from that template.

## Upgrading

If you installed this fork with `--link`:

```sh
cd /absolute/path/to/openclaw-wecom-plugin-fork
git pull
openclaw gateway restart
```

If you installed this fork as a copied plugin, reinstall after pulling changes:

```sh
cd /absolute/path/to/openclaw-wecom-plugin-fork
git pull
openclaw plugins install /absolute/path/to/openclaw-wecom-plugin-fork
openclaw gateway restart
```

## Approval Flow

When a WeCom session triggers an exec approval:

- the request is mirrored to `channels.wecom.approvals.notifyTo` over DM
- the approver responds with `/approve <id> allow-once`, `/approve <id> allow-always`, or `/approve <id> deny`
- only the configured owner/admin users can resolve approvals

`/approve` is intentionally DM-only by default.

## Known Limitations

- Approval delivery depends on the gateway CLI being available to the plugin runtime for `openclaw gateway call exec.approval.resolve`.
- This fork is maintained from packaged `dist/` artifacts rather than the upstream source tree.
