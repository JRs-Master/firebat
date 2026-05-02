# Acknowledgements

Firebat is built as a **3-LLM collaborative project** — designed, written, and refined
together by humans and three frontier AI models. Each model contributed at different
stages and in different roles.

## AI contributors

### Anthropic — [Claude](https://claude.com/claude-code)
- Bulk of the recent codebase (CMS V2 builder, memory system, AI tool framework,
  Function Calling integration, hexagonal refactor)
- Code review and architectural decisions
- Used via [Claude Code](https://claude.com/claude-code) (CLI) and the Anthropic API

### OpenAI — [GPT](https://openai.com/) / [Codex CLI](https://github.com/openai/codex)
- Co-author of the **FIREBAT_BIBLE** (architectural principles, ports & adapters
  design, single-tenant constraints)
- Coding contributions via Codex CLI
- Used via [Codex CLI](https://github.com/openai/codex), GPT-5 / GPT-5.5 series

### Google — [Gemini](https://gemini.google.com/) / [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **Initial Firebat prototype** — early version of the codebase that became the
  foundation for the current architecture
- Co-author of the **FIREBAT_BIBLE** (alongside GPT)
- Coding contributions via Gemini CLI
- Used via [Gemini CLI](https://github.com/google-gemini/gemini-cli), Gemini 2.5 / 3 series
  (Pro / Flash) and Vertex AI

## Why this matters

Firebat itself is an **AI-powered Visual Automation Agent** (VAA) — a platform where
multiple LLMs orchestrate code, content, and automation. It is fitting that the
platform itself was built by the same kind of AI ↔ human collaboration it now enables.

The three frontier models each bring different strengths: Claude excels at large
refactors and architectural reasoning, GPT excels at thorough specification writing
and edge-case analysis, Gemini excels at fast prototyping and multi-modal reasoning.
This project leans into all three.

## Programs

This project is eligible for the following OSS support programs:
- [Anthropic Claude for OSS](https://www.anthropic.com/) — Claude Pro/Max free tier
- [OpenAI Codex for OSS](https://openai.com/) — Codex CLI free tier
- [Google AI Pro for OSS](https://ai.google/) — Gemini CLI free tier

License: [AGPL-3.0](LICENSE) — dual licensing available for commercial closed-source
deployment (contact maintainer).
