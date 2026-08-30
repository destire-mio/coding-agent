# coding-agent

A build-to-learn Coding Agent project aiming for a runnable, explainable,
testable, production-grade v1.

## Current milestone

Build the first read-only vertical slice:

```text
TUI
→ Agent Core / ReAct Loop
→ model-generated Read tool call
→ Tool Runtime validation and workspace boundary enforcement
→ structured Observation
→ final model answer
```

The first user task will be:

> Read `README.md` from the workspace and summarize it.

This milestone intentionally excludes Bash, Edit, multi-agent coordination,
long-term memory/RAG, and a complex TUI.

## Status

Project initialized. The Agent implementation has not started yet.

## License

[MIT](LICENSE)
