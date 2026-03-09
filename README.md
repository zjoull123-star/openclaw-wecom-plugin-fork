# WeCom OpenClaw Plugin Fork

Patched WeCom channel plugin for [OpenClaw](https://github.com/openclaw).

This fork adds:

- WeCom long-connection bot access
- Auto-provisioned per-user DM agents and workspaces
- Auto-provisioned per-group agents with mention-only activation
- Owner-only high-risk commands for `/config set`, `/config unset`, `/restart`, `/approve`, `/activation`, `!`, and `/bash`

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

## Known Limitation

This fork does not yet add a WeCom-native exec approval notification flow. If a conversation triggers host execution that requires approval, the session can block waiting for approval. For production use, keep that risk in mind when enabling elevated tools for general chat users.
