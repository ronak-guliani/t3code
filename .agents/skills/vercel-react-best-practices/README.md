# React Best Practices

> Vendored subset of [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices).
> This directory carries the rule files, `SKILL.md`, `AGENTS.md`, and metadata only. The upstream build tooling (`src/`),
> generated `test-cases.json`, and package scripts are not vendored: run `pnpm build`, `pnpm validate`, and
> `pnpm extract-tests` in the upstream repository, then re-vendor the results here.

A structured repository for creating and maintaining React Best Practices optimized for agents and LLMs.

## Structure (vendored)

- `rules/` - Individual rule files (one per rule)
  - `_sections.md` - Section metadata (titles, impacts, descriptions)
  - `_template.md` - Template for creating new rules
  - `area-description.md` - Individual rule files
- `metadata.json` - Document metadata (version, organization, abstract)
- **`AGENTS.md`** - Compiled output (vendored copy of the upstream generated file)
- `SKILL.md` - Skill definition (upstream `license: MIT`, author `vercel`; see `NOTICE.md`)
- `NOTICE.md` - Upstream license attribution for this vendored copy

Not vendored: upstream `src/` build scripts and generated `test-cases.json`.
Do not run `pnpm build`, `pnpm validate`, `pnpm extract-tests`, or `pnpm dev`
in this directory; this checkout has no package manifest providing them.

## Updating from upstream

1. In an upstream checkout of
   [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices),
   run `pnpm install`, `pnpm build`, `pnpm validate`, and `pnpm extract-tests`.
2. Re-vendor the resulting `rules/`, `SKILL.md`, `AGENTS.md`, and
   `metadata.json` into this directory.
3. If upstream adds a license file or copyright notice, re-vendor it into
   `NOTICE.md` alongside the skill files.

## Rule File Structure

Each upstream rule file follows this structure:

````markdown
---
title: Rule Title Here
impact: MEDIUM
impactDescription: Optional description
tags: tag1, tag2, tag3
---

## Rule Title Here

Brief explanation of the rule and why it matters.

**Incorrect (description of what's wrong):**

```typescript
// Bad code example
```
````

**Correct (description of what's right):**

```typescript
// Good code example
```

Optional explanatory text after examples.

Reference: [Link](https://example.com)

## File Naming Convention (upstream)

- Files starting with `_` are special (excluded from build)
- Rule files: `area-description.md` (e.g., `async-parallel.md`)
- Section is automatically inferred from filename prefix
- Rules are sorted alphabetically by title within each section
- IDs (e.g., 1.1, 1.2) are auto-generated during the upstream build

## Impact Levels

- `CRITICAL` - Highest priority, major performance gains
- `HIGH` - Significant performance improvements
- `MEDIUM-HIGH` - Moderate-high gains
- `MEDIUM` - Moderate performance improvements
- `LOW-MEDIUM` - Low-medium gains
- `LOW` - Incremental improvements

## Contributing (upstream)

Propose or modify rules in the upstream repository, following its
`_template.md` structure and filename prefixes. Then re-vendor the results
here per "Updating from upstream" above.

## Acknowledgments

Originally created by [@shuding](https://x.com/shuding) at [Vercel](https://vercel.com).
See `NOTICE.md` for the upstream license attribution.
