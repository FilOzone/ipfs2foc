/**
 * One anonymous metric point per finished command, posted to the same
 * operational metrics source the hosted console reports into. The body
 * mirrors the console's emitter (app/src/telemetry.ts): an array of
 * `{name, counter, dt, tags}` with a bearer token. A point carries the
 * command name and whether it succeeded — never CIDs, addresses, paths,
 * or arguments.
 *
 * The endpoint and token are inlined at release build time (tsup `env`, fed
 * by the release workflow), so a source checkout or test run has neither and
 * the emitter is off. Operators opt out with DO_NOT_TRACK=1 or
 * SCARF_ANALYTICS=false, the same switches the install-time Scarf check
 * honors; the opt-out is stated in the CLI help text and in the hosted
 * migration runbook.
 */

const ENDPOINT = process.env.IPFS2FOC_METRICS_ENDPOINT
const TOKEN = process.env.IPFS2FOC_METRICS_TOKEN

/**
 * True when the operator asked not to be tracked: DO_NOT_TRACK set to
 * anything but ''/'0'/'false', or Scarf's SCARF_ANALYTICS=false.
 */
export function telemetryOptedOut(env: Record<string, string | undefined> = process.env): boolean {
  const dnt = env.DO_NOT_TRACK?.toLowerCase()
  if (dnt != null && dnt !== '' && dnt !== '0' && dnt !== 'false') {
    return true
  }
  return env.SCARF_ANALYTICS?.toLowerCase() === 'false'
}

/** Report one command run. Resolves within the timeout and never throws. */
export async function recordCommandRun(cmd: string, ok: boolean): Promise<void> {
  await post([
    { name: 'cliCommandRun', counter: { value: 1 }, dt: new Date().toISOString(), tags: { cmd, ok: String(ok) } },
  ])
}

/**
 * Migration-size signal, emitted when an upload run finishes: how many CIDs
 * the list held, how many migrated, and the bytes stored. Counts and sizes
 * only, as gauge values — never the CIDs themselves. This is the CLI half of
 * the campaign funnel; the landing page counts pastes the same way.
 */
export async function recordUploadOutcome(o: { cids: number; migrated: number; storedBytes: number }): Promise<void> {
  const dt = new Date().toISOString()
  await post([
    { name: 'cliUploadCids', gauge: { value: o.cids }, dt },
    { name: 'cliUploadCidsMigrated', gauge: { value: o.migrated }, dt },
    { name: 'cliUploadStoredBytes', gauge: { value: o.storedBytes }, dt },
  ])
}

async function post(points: object[]): Promise<void> {
  if (!ENDPOINT || !TOKEN || telemetryOptedOut()) {
    return
  }
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(points),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // Best effort: telemetry never surfaces to the operator.
  }
}
