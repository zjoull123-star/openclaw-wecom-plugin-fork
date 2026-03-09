# Config Profiles

## Base profile

The bootstrap script always applies these settings:

- `channels.wecom.botId`
- `channels.wecom.secret`
- `channels.wecom.enabled = true`
- `channels.wecom.dmPolicy = "open"`
- `channels.wecom.allowFrom = ["*"]`
- `channels.wecom.groupPolicy = "open"`
- `channels.wecom.configWrites = true`
- `channels.wecom.autoProvision.enabled = true`
- `channels.wecom.autoProvision.registryPath = "~/.openclaw/credentials/wecom-auto-agents.json"`
- `channels.wecom.autoProvision.templateDir = "~/.openclaw/templates/wecom-default-agent"`
- `channels.wecom.autoProvision.dm.agentIdPrefix = "wecom-dm"`
- `channels.wecom.autoProvision.dm.workspaceRoot = "~/.openclaw/workspace-wecom/dm"`
- `channels.wecom.autoProvision.group.agentIdPrefix = "wecom-group"`
- `channels.wecom.autoProvision.group.workspaceRoot = "~/.openclaw/workspace-wecom/group"`
- `channels.wecom.autoProvision.group.requireMention = true`
- `plugins.allow` merged with `"wecom-openclaw-plugin"`

Result:

- Every WeCom DM user gets a dedicated top-level agent and workspace.
- Every WeCom group gets one dedicated group agent.
- Group auto-provision only happens on mention.
- Local CLI and app usage stay on `main`.

## Owner admin profile

When `--owner <userid>` is supplied, the script also applies:

- `commands.ownerAllowFrom` merged with `"wecom:<userid>"`
- `commands.config = true`
- `commands.restart = true`

Result:

- The owner can use `/config set`, `/config unset`, `/restart`, `/approve`, and `/activation` through WeCom, subject to the plugin's owner checks.

## Owner shell profile

When `--enable-owner-shell` is supplied with `--owner`, the script also applies:

- `commands.bash = true`
- `tools.elevated.enabled = true`
- `tools.elevated.allowFrom.wecom` merged with `<userid>`
- `agents.defaults.elevatedDefault = "off"`

Why shell access is opt-in:

- This fork still does not implement a WeCom-native exec approval notification path.
- Leaving elevated execution broadly available can block chat sessions if model-initiated exec waits for approval.
- Setting `agents.defaults.elevatedDefault = "off"` reduces that risk for normal chat sessions while still allowing explicit `/bash` by the owner.

## Install modes

Default install mode is linked install:

```bash
openclaw plugins install --link /path/to/openclaw-wecom-plugin-fork
```

Use copied install only when the user does not want the installed plugin to track the local checkout:

```bash
openclaw plugins install /path/to/openclaw-wecom-plugin-fork
```
