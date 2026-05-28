# Research Folder Is Gitignored

**Trigger:** Writing any markdown file that is exploratory rather than user-facing.

## Rule

- Investigation drafts, peer-review prompts, peer-review outputs, and design memos go under `.research/` at the repo root.
- `.research/` is gitignored. Long-form research never lands in git history.
- When an investigation matures into a shipped feature, extract the durable rules into a `docs/` doc and discard the rest.
- Do not put exploratory markdown in `docs/`, `README.md`, or PR descriptions.

## Examples

### Bad

```
docs/option-c-vs-option-a-analysis.md
docs/peer-review-prompt-2026-05.md
```

### Good

```
.research/option-c-vs-option-a-analysis.md   # gitignored
.research/peer-review-prompt-2026-05.md      # gitignored
docs/piece-assembly.md                        # extracted durable rule, committed
```

## Why

Exploratory writing is verbose, dated, and contradicts itself across drafts. Shipping it in `docs/` makes the project look unfinished and confuses readers who expect docs to describe current behavior.
