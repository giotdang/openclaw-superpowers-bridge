# Superpowers Bridge for OpenClaw

An OpenClaw plugin that automatically fetches the [Superpowers](https://github.com/obra/superpowers)
workflow skills from GitHub and injects the relevant ones into the agent prompt.

> Hardened fork of [vruru/superpowers-bridge](https://github.com/vruru/superpowers-bridge)
> (MIT), modernized for current OpenClaw (tested on `2026.5.18`).

## What it does

- **Auto-fetch** — on first start it `git clone --depth 1`s the skills repo into a local cache.
- **Auto-select** — keyword detection picks the skills relevant to the current prompt.
- **Inject** — the selected skills are prepended to the prompt context (`before_prompt_build`).
- **Manual load** — the `superpowers_skill` tool loads any skill on demand.
- **Update** — `update_superpowers_skills` runs `git pull`; `superpowers_version` reports the
  cached commit.

## What this fork changes vs. upstream

Upstream targeted an older plugin SDK. This fork:

- Uses the **non-deprecated `before_prompt_build`** hook (upstream used legacy `before_agent_start`).
- Uses the **current agent-tool contract** (`label` + `execute(toolCallId, params)`, returning
  `{ content: [{ type: "text", text }], details }`) — upstream returned a shape the SDK no longer accepts.
- Declares `contracts.tools` + `activation.onStartup` in `openclaw.plugin.json` so the tools are
  discoverable before runtime load.
- Renames the generic `skill` tool to `superpowers_skill` to avoid collisions with core tools.
- Adds **Vietnamese + English** keyword detection (ASCII keywords match on word boundaries).
- Adds cost controls: `injectionMode` (`summary`/`full`), `maxInjectedChars`,
  `injectOncePerSession`.
- Ships compiled `dist/index.js` (`runtimeExtensions`) because `openclaw plugins install`
  requires built JavaScript.
- Has **no external runtime dependencies** (Node built-ins only).

## Install

### Option A — plugin root (recommended, works with the dangerous-code scanner)

The plugin shells out to `git`, so `openclaw plugins install` flags it as "dangerous code"
and blocks the install. Install it into the shared plugin root instead — this makes the
plugin (and its skills cache) available to **every agent** on the machine:

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/giotdang/openclaw-superpowers-bridge.git \
  ~/.openclaw/extensions/superpowers-bridge
npm --prefix ~/.openclaw/extensions/superpowers-bridge run build   # optional: rebuild dist (dist is committed)
```

Then in `~/.openclaw/openclaw.json`: enable the plugin, and let each agent opt in to the
plugin-owned tools. **Important:** plugin-owned tools are only exposed when the agent's tool
policy uses `profile` + `alsoAllow`; listing them in `tools.allow` alone does *not* expose them
(and `allow` + `alsoAllow` in the same scope is rejected by config validation).

```json
{
  "plugins": {
    "entries": {
      "superpowers-bridge": {
        "enabled": true,
        "config": {
          "injectionMode": "summary",
          "maxInjectedChars": 3600,
          "injectOncePerSession": true
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "profile": "coding",
          "alsoAllow": ["superpowers_skill", "update_superpowers_skills", "superpowers_version"]
        }
      }
    ]
  }
}
```

```bash
openclaw config validate
openclaw gateway restart   # or: systemctl restart openclaw-gateway
```

Repeat the `tools` block for each agent that should be able to load skills manually.
Prompt injection (auto-select) works for every agent regardless of the tool policy.

### Option B — package install

Only if you accept the shell-exec warning:

```bash
openclaw plugins install ~/.openclaw/workspace/projects/superpowers-bridge \
  --dangerously-force-unsafe-install
```

## Configuration

| Option                 | Type                      | Default                                   | Description                                                        |
| ---------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `enabled`              | boolean                   | `true`                                    | Enable/disable the plugin.                                         |
| `skillsRepo`           | string                    | `https://github.com/obra/superpowers.git` | Skills repo to clone.                                              |
| `autoDetectCode`       | boolean                   | `true`                                    | Auto-select skills by keyword.                                     |
| `autoUpdate`           | boolean                   | `false`                                   | `git pull` on plugin start.                                        |
| `injectionMode`        | `"summary"` \| `"full"`   | `"summary"`                               | summary = names + descriptions; full = full skill bodies.          |
| `maxInjectedChars`     | number                    | `3600`                                    | Hard cap on injected context (`0` = unlimited).                    |
| `injectOncePerSession` | boolean                   | `true`                                    | Inject each skill at most once per session.                        |
| `defaultSkill`         | string                    | `"using-superpowers"`                     | Skill always marked relevant.                                      |
| `autoSelectSkills`     | string[]                  | —                                         | Optional whitelist of skills eligible for auto-selection.          |
| `extraKeywords`        | `{ [skill]: string[] }`   | —                                         | Extra trigger keywords per skill, merged with built-ins.           |

## Tools

- `superpowers_skill` — load the full text of a skill by name.
- `update_superpowers_skills` — `git pull` the skills repo and reload.
- `superpowers_version` — report the cached skills commit + date.

## Verify

```bash
openclaw plugins inspect superpowers-bridge --runtime --json
```

Expected: `"status": "loaded"`, the three tools above, and `hookCount: 1`.

To confirm an agent actually *receives* the tools, run a throwaway turn and inspect the
compiled context (OpenClaw records it under `agents/<id>/sessions/<id>.trajectory.jsonl`
as a `context.compiled` record):

```bash
openclaw agent --agent zeus --session-id spcheck --message "Reply exactly: OK"
```

## Gotchas learned the hard way

- `openclaw plugins install` blocks the plugin (shell exec via `git`). Install into
  `~/.openclaw/extensions/` instead — no scanner, no `--dangerously-force-unsafe-install` needed.
- `tools.allow: ["<tool-name>"]` does **not** reveal plugin-owned tools. Use
  `tools.profile` + `tools.alsoAllow`. Setting both `allow` and `alsoAllow` in the same
  scope fails config validation.
- `openclaw gateway restart` (or `systemctl restart openclaw-gateway`) kills any `exec`
  shell running under the gateway — run the restart detached (`setsid ... &`) if you need
  the calling shell to survive.

## Attribution & license

MIT. Original plugin by [vruru](https://github.com/vruru/superpowers-bridge);
workflow skills by [obra/superpowers](https://github.com/obra/superpowers) (Jesse Vincent / Prime Radiant).
See [LICENSE](LICENSE).
