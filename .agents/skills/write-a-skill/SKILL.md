---
name: write-a-skill
description: Create or update an agent skill when the user explicitly asks to author, install, or revise a skill, its trigger, workflow, or bundled resources.
---

# Writing Skills

## Process

1. **Gather requirements** - infer the task and ask only about unresolved consequential choices: supported trigger phrases, authorized side effects, required tools, and expected delivery.

2. **Draft the skill** - create:
   - SKILL.md with concise instructions
   - Additional reference files when content is detailed, variant-specific, or useful only for selected tasks
   - Utility scripts if deterministic operations needed

3. **Review** - check the trigger, references, relative links, permissions, and completion criteria. Ask for review when the user requested an interactive design process or when a consequential choice remains unresolved.

## Skill Structure

```
skill-name/
├── SKILL.md           # Main instructions (required)
├── REFERENCE.md       # Detailed docs (if needed)
├── EXAMPLES.md        # Usage examples (if needed)
└── scripts/           # Utility scripts (if needed)
    └── helper.js
```

## SKILL.md Template

```md
---
name: skill-name
description: Brief description of capability. Use when [specific triggers].
---

# Skill Name

## Quick start

[Minimal working example]

## Workflows

[Step-by-step processes with checklists for complex tasks]

## Advanced features

[Link to a task-specific reference file when one is needed]
```

## Description Requirements

The description is **the only thing your agent sees** when deciding which skill to load. It's surfaced in the system prompt alongside all other installed skills. Your agent reads these descriptions and picks the relevant skill based on the user's request.

**Goal**: Give your agent just enough info to know:

1. What capability this skill provides
2. When/why to trigger it (specific keywords, contexts, file types)

**Format**:

- Max 1024 chars
- Write in third person
- First sentence: what it does
- Second sentence: "Use when [specific triggers]"

**Good example**:

```
Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when user mentions PDFs, forms, or document extraction.
```

**Bad example**:

```
Helps with documents.
```

The bad example gives your agent no way to distinguish this from other document skills.

## When to Add Scripts

Add utility scripts when:

- Operation is deterministic (validation, formatting)
- Same code would be generated repeatedly
- Errors need explicit handling

Scripts save tokens and improve reliability vs generated code.

## When to Split Files

Split into separate files when content has distinct domains, variants, examples, schemas, or advanced details that are not needed for every invocation. Keep the root focused on routing and the core workflow; choose the split based on task context rather than an arbitrary line count.

## Review Checklist

After drafting, verify:

- [ ] Description includes triggers ("Use when...")
- [ ] No time-sensitive info
- [ ] Consistent terminology
- [ ] Concrete examples included
- [ ] References one level deep
