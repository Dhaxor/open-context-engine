---
title: I gave Claude Code a retrieval engine — here's what changed
published: false
description: A local, measured retrieval layer for your coding agent. Three commands, no cloud, and answers that cite real files.
tags: ai, claudecode, mcp, tooling
cover_image: https://opencontextengine.com/og-image.png
---

> **Draft — do not publish without review.** Target platform: dev.to (also suitable for Hashnode / Medium repost). The links point at opencontextengine.com pages that are live as of 2026-11-08.

---

Claude Code is a strong agent, but on a real repository it hits the same wall every coding agent hits: the codebase is bigger than the context window. Whatever its search surfaces first decides whether the edit lands in the right function — or invents an API that doesn't exist.

So I stopped treating retrieval as an afterthought and gave the agent a dedicated engine: [Open Context Engine](https://opencontextengine.com) (OCE, MIT core). Three commands, everything local:

```bash
npm install -g @dhaxor/open-context
oce index
claude mcp add oce -- oce mcp
```

That's the whole integration. Claude Code now starts OCE's MCP server per session and gets these tools:

- `codebase-retrieval` — hybrid semantic + keyword search over AST-aware chunks
- `repo-map` — the codebase's structure in a few thousand tokens
- `find-symbol-definition` / `find-symbol-references` — compiler-grade when a language server is installed
- `read-file`, `list-files`, `index-status`

## What "measured" means, and why I care

I've used agent tools that claim great retrieval and ship vibes. OCE scores committed gold sets with recall@k, MRR, and nDCG in CI — the [benchmarks page](https://opencontextengine.com/benchmarks) is generated from the eval harness's own reports (hybrid recall@10: 0.943 on its own codebase; parity with keyword-only on Flask). The harness ships with the product, so I can score it on my own repos instead of trusting marketing.

## The part nobody else gives you: seeing the context

The feature that sold me isn't search quality — it's the [evidence rail](https://opencontextengine.com/context-engineering). Run `oce trace` and you see exactly which chunks were retrieved at which scores, what got pinned, and what got evicted as the conversation grew. When an agent breaks something, I can answer "what did it actually know at that step?" — which turns debugging from folklore into inspection.

## Privacy, stated precisely

OCE itself never uploads anything: indexing, embeddings (in-process MiniLM by default — no API key), and the SQLite index are entirely local, and the MCP server runs on stdio. One honest caveat: the *retrieved snippets* go into Claude Code's context, which travels to your LLM provider as part of any normal session. OCE adds nothing extra on the wire — but it isn't magic about where prompts go. [Full privacy notes here.](https://opencontextengine.com/claude-code)

## Does it actually change outcomes?

The failure modes I stopped seeing: hallucinated APIs, edits to the wrong file, "fixes" that break callers the agent never saw. The comparison I wrote up — [OCE vs Cursor, Copilot, and grep](https://opencontextengine.com/comparison) — is deliberately honest: if Cursor's built-in indexing covers your workflow, keep it. OCE earns its place when you want multi-client grounding, inspectable retrieval, or a local-only guarantee you can verify.

If you try it, start with `oce index` on a repo you know well, then ask the agent a question you already know the answer to. The retrieval either shows you the file you'd have opened — or it doesn't, and you've saved yourself the subscription.

---

*Open Context Engine is MIT-licensed core with optional Team features. It's also [listed in the official MCP registry](https://opencontextengine.com/changelog) — `io.github.Dhaxor/open-context-engine`.*
