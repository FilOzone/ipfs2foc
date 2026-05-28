Source: ~/.claude/skills/github-writing/SKILL.md

# GitHub Issue Structure

**Trigger:** Opening or editing a GitHub issue.

## Rule

- Title follows the repo's convention. If typed prefixes are used: `[Type]: brief specific description`. No vague titles like `fix migration issue`.
- Body sections in order: Description, Impact, Steps to Reproduce, Expected Behavior, Actual Behavior, Environment, Additional Context.
- Omit any section that has nothing useful. Steps/Expected/Actual apply to bugs; Environment only when relevant.
- Target ~150–250 words. The body must stand alone with no private-conversation context.
- Link related issues and docs rather than restating them.

## Examples

### Bad

Title: `fix dataset bug`

Body: As we discussed, the thing is broken. See chat. Please fix soon.

### Good

Title: `[Bug]: Migrated Storacha datasets are hidden from dataset list`

Body: Description, Impact, Steps to Reproduce, Expected, Actual, Environment, with a link to the investigation gist.

## Why

A reader should grasp the problem, impact, and next action in under 60 seconds without backchannel context.
