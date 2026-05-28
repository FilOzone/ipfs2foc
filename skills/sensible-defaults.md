# Sensible Defaults

**Trigger:** Adding a new CLI flag, env var, or config knob.

## Rule

- Pick the default that produces the safest outcome for the most common operator.
- Defaults should not require reading three doc pages to set.
- Opt-in flags toggle the expensive or destructive path, not the safe path.
- State the default value in `--help` text on the same line as the flag.

## Examples

### Bad

```
--cache=on|off   (required, no default)
--sample=N       (required, must read docs to know if 100 is sane)
```

### Good

```
--cache         Cache source bytes locally (default: on; --no-cache to disable when disk is tight)
--sample N      Number of CIDs to probe (default: 100; use --all for full sweep)
```

## Why

A flag with no default forces every operator to think about something the maintainer already knows the answer to. Cache-on is cheap insurance against source gateway outages; sample-100 is enough signal for a million-CID migration.
