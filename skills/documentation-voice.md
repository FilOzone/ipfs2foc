Source: ~/.claude/skills/github-writing/SKILL.md

# Documentation Voice

**Trigger:** Writing or editing any persistent doc (README, design note, ADR, in-repo Markdown).

## Rule

- Describe the system as it is now. Docs are not a changelog or PR description.
- Frame upstream projects, SDKs, and dependencies factually. Do not critique them.
- Cut change-justification. If a sentence only matters to a reviewer of the diff, delete it.
- Verify behavior before stating it. When unsure, link to the authoritative source.
- Link to source code, type defs, or API specs rather than restating them in prose.

## Examples

### Bad

Previously the API exposed N callbacks; now it exposes M unified events. We changed this because the upstream SDK's design was confusing.

### Good

The API exposes M unified progress events listed below. See `src/events.ts` for the type definitions.

## Why

Docs are read by people with no memory of the diff. Change-framing and upstream criticism age badly and break trust when claims drift from the code.
