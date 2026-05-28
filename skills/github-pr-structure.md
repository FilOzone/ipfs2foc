Source: ~/.claude/skills/github-writing/SKILL.md

# GitHub PR Structure

**Trigger:** Writing or editing a pull request description.

## Rule

- `What changed` is required: 1–2 sentences naming the change and the reason.
- `How to verify` lists commands or reviewer steps when manual checks apply.
- `Notes / risks` only when there is a behavior change, migration, or real uncertainty.
- Target ~100–200 words. No private-conversation framing ("as we discussed", "per Slack").
- Drop empty sections.

## Examples

### Bad

As discussed in DMs, this fixes the thing. Should be good to merge. Let me know.

### Good

What changed: Aggregate Synapse per-callback events into a single `onProgress` stream so consumers subscribe once.

How to verify: `pnpm test events` and run the upload example; observe one progress event per chunk.

## Why

PR descriptions are read by reviewers and future archaeologists. A self-contained `What changed` lets both act without chasing chat history.
