# WeCom OpenClaw Plugin

WeCom channel plugin for [OpenClaw](https://github.com/openclaw).

## Features

- WeCom long-connection bot access
- Auto-provisioned per-user DM agents and workspaces
- Auto-provisioned per-group agents with mention-only activation
- Owner-only high-risk commands for `/config set`, `/config unset`, `/restart`, `/approve`, `/activation`, `!`, and `/bash`

## Install

```sh
openclaw plugins install @wecom/wecom-openclaw-plugin
```

## Minimal channel setup

```sh
openclaw config set channels.wecom.botId <BOT_ID>
openclaw config set channels.wecom.secret <SECRET>
openclaw config set channels.wecom.enabled true
openclaw gateway restart
```

## Multi-user auto-provision setup

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "open",
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

## Template seeding

On first use, the plugin seeds `~/.openclaw/templates/wecom-default-agent` from the current default workspace starter files:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `skills/`

New WeCom workspaces are copied from that template.
