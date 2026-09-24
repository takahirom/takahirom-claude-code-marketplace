# Idle Compact

A Claude Code function-hooks plugin (Mod) that compacts the conversation **once** after 50 idle minutes, while the 1h prompt cache is still warm.

**In simple terms**: If you leave a long session alone, coming back after the 1h cache TTL re-caches the whole context. This plugin compacts shortly before that happens, so the next turn starts from a small, cheap context. It never keeps the cache alive, and it does nothing more after that one compaction.

> **⚠️ Note**: Function hooks are early access. Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (for example in the `env` block of `~/.claude/settings.json`). Written against Claude Code 2.1.280.

## How to Install (Plugin)

```
/plugin marketplace add takahirom/takahirom-claude-code-marketplace
/plugin install idle-compact@takahirom-claude-code-marketplace
```

## Execution Flow

```mermaid
flowchart TD
    A[main turn.complete<br/>reason: answer] --> B[Arm one 50 min timer<br/>remember wall-clock time and session id]
    B --> C{What comes first?}
    C -->|turn.start / session.end / manual compact| D[Cancel timer]
    D -->|next main turn completes| A
    C -->|timer fires| E{elapsed 50–58 min,<br/>same session,<br/>still the latest timer?}
    E -->|No: e.g. Mac slept, cache cold| F[Do nothing]
    E -->|Yes| G[$.session.compact]
    G --> H[Done: no re-arm, no retry]
```

- Only the main conversation arms the timer. Subagent completions (`agentId`), aborted or failed turns, and completions without a matching `turn.start` are ignored.
- The timer callback checks the wall clock (`$.clock.now()`) again. A timer that runs late, for example after the Mac slept, does nothing once 58 minutes have passed, because by then the cache may already be cold.
- The wall-clock anchor is the time `turn.complete` fired. Claude Code does not expose the cache's own last-activity time or TTL to plugins, so a session on the 5m TTL is not detected.
- A failed compaction, one refused because a turn is running or because `DISABLE_COMPACT` is set, is ignored silently and not retried.

## Development

```sh
claude plugin validate plugins/idle-compact
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/idle-compact
```

Types come from `/plugin-types` (written to `.claude/types`, not committed).
