# takahirom-claude-code-marketplace

## Plugins

### [claude-code-quality-gate](./plugins/claude-code-quality-gate)

A quality automation system using Claude Code Hooks and Subagents to enforce code quality standards automatically.

### [skill-extractor](./plugins/skill-extractor)

Extract learnings from conversation and save as reusable skills.

### [idle-compact](./plugins/idle-compact)

Compact once after 50 idle minutes, while the 1h prompt cache is still warm (function hooks, early access).

## Install

```
/plugin marketplace add takahirom/takahirom-claude-code-marketplace
/plugin install claude-code-quality-gate@takahirom-claude-code-marketplace
/plugin install skill-extractor@takahirom-claude-code-marketplace
/plugin install idle-compact@takahirom-claude-code-marketplace
```
