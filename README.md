# Copilot Agent Runtime Experiments

Research and prototype repository for experimenting with:

- GitHub Copilot agent workflows
- Context optimization and hygiene
- Agent observability
- Token and cost reduction
- Orchestrator / sub-agent architecture
- Persistent working memory patterns
- Runtime telemetry analysis

> This repository is experimental and research-oriented.
> The workflows, prompts and architecture patterns are still evolving.

---

# Repository Structure

```text
.
├── README.md
├── presentation/
│   └── agent-runtime-presentation.html
├── scripts/
│   ├── README.md
│   ├── analyze-events.csx
│   ├── export-events.csx
│   └── lib/
│       ├── evens-core.csx
│       └── events-annotations.csx
└── .copilot/
    └── agents/
        ├── brainstorm.agent.md
        ├── build.agent.md
        ├── plan.agent.md
        ├── sub-debugger.agent.md
        ├── sub-explorer.agent.md
        ├── sub-researcher.agent.md
        ├── sub-reviewer.agent.md
        └── util-workflow-analyst.agent.md
```

---

# Contents

## presentation/

Contains the original HTML presentation used during a talk.

The presentation covers topics such as:

- Usage-based pricing impact
- Context entropy
- Agent loop behavior
- Context compaction
- Context hygiene
- MCP/tooling optimization
- Orchestrator/sub-agent architecture
- Persistent working memory
- Token cost optimization
- Observability gaps in current runtimes

The presentation is self-contained and can be opened directly in any browser.

## scripts/

Contains telemetry parsing and session analysis scripts for GitHub Copilot CLI runtime sessions.

Current tooling includes:

- session event parsing
- telemetry extraction
- tool usage analysis
- token usage analysis
- model usage analysis
- sub-agent execution tracing
- timeline reconstruction
- warning/error extraction
- structured export for further analysis

The scripts are intended for experimentation, debugging and workflow optimization.

See [scripts/README.md](scripts/README.md) for additional details.

## .copilot/agents/

Contains experimental custom workflow configuration and agent definitions.

The workflow is based on an orchestrator/sub-agent architecture where:

- orchestrators focus on reasoning and coordination
- worker agents execute specialized tasks
- expensive models are isolated to high-level reasoning
- cheaper models are used for execution and exploration
- context pollution is minimized through task isolation

The setup is intentionally modular and intended for experimentation and iteration.

---

# Core Ideas

## Context Hygiene

Large noisy contexts reduce model quality, increase latency and dramatically increase cost.

This repository experiments with techniques such as:

- disabling unnecessary MCP servers
- minimizing tool exposure
- narrow and precise prompts
- isolated workflows
- reduced context pollution
- compact tool outputs

## One Session = One Task

Long-running sessions tend to accumulate:

- context entropy
- duplicated information
- degraded reasoning quality
- excessive compaction
- unnecessary token consumption

This workflow encourages smaller isolated sessions with explicit state transfer when needed.

## Orchestrator / Worker Separation

The architecture separates:

**High-level reasoning**

Handled by orchestrator agents using stronger models.

**Specialized execution**

Handled by lightweight worker agents using cheaper/faster models.

This helps reduce:

- token usage
- context growth
- tool noise
- compaction frequency

while improving:

- observability
- modularity
- execution speed
- workflow control

## Persistent Working Memory

The workflow experiments with explicit persistent memory files instead of relying entirely on opaque runtime memory systems.

Advantages include:

- human-readable state
- editable memory
- cross-session reuse
- better post-compaction recovery
- explicit knowledge transfer

## Observability

Current agent runtimes expose very limited visibility into:

- agent loops
- tool calls
- sub-agent behavior
- context growth
- runtime decisions

The included tooling attempts to improve runtime observability through telemetry analysis and structured event extraction.

---

# Important Notes

- This repository is not production-ready.
- The workflows are experimental.
- Some ideas may change significantly over time.
- The setup is intentionally research-oriented.
- The implementation is optimized for exploration and iteration rather than stability.

---

# Goals

The primary goal of this repository is to explore:

- scalable agent workflows
- efficient runtime architectures
- token-efficient orchestration
- observability tooling
- practical engineering patterns for LLM agents

especially under usage-based pricing models.

---

# Disclaimer

This repository represents personal research and experimentation.
It is not affiliated with or endorsed by GitHub, Microsoft or Anthropic.

---

# License

This repository is licensed under the MIT License. See [LICENSE](LICENSE) for more details.
