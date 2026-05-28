Source: ~/.claude/skills/github-writing/SKILL.md

# Investigation Split

**Trigger:** Any investigation result with more than ~250 words of evidence, options, or reviewer notes.

## Rule

- Split into a short tracker issue plus a linked detail doc. Do not paste the full investigation into the issue.
- The GitHub issue states root cause, impact, current workaround, and proposed next step. Target ~150 words.
- Pick the doc surface by content type: gist (default secret, link-only) for raw logs, repros, code dumps, line-anchor links; Notion or Obsidian for living memos, decision logs, multi-author edits.
- Link the detail doc from the issue. Keep evidence out of the tracker.

## Examples

### Bad

A 2,000-word issue body pasting full logs, three rejected hypotheses, and a transcript of debugging steps.

### Good

Issue body: root cause (race in `pullBatch`), impact (50% of large uploads stall), workaround (cap batch at 100), next step (apply v2 envelope fix). Link: `gist.github.com/.../pullbatch-race.md`.

## Why

Tracker items drive decisions. Burying the decision under evidence makes the issue unreadable and the evidence unfindable. Split surfaces serve their separate jobs.
