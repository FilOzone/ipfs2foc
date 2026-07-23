/**
 * The signing-session explainers. What the one wallet approval authorizes,
 * stated before the user grants it, and the expiry warning once a session is
 * close to lapsing.
 */

/** Shown before the grant: exactly what the temporary key can and cannot do. */
export function SessionGrantExplainer({ availableLabel, longWindow }: { availableLabel: string; longWindow: boolean }) {
  return (
    <span className="pay-setup">
      One wallet approval authorizes a temporary key to sign migration steps for the chosen window. It can create data
      sets and add pieces, spending from the {availableLabel} available, and nothing else: no removals, no deletions, no
      withdrawals. Revoke it here when the run is done.
      {longWindow &&
        ' Long windows leave the key authorized on this device for days. Prefer shorter unless the run needs it.'}
    </span>
  )
}

/** Shown when the active session is inside the pre-expiry margin. */
export function SessionExpiryNote() {
  return (
    <span className="pay-setup">
      This session expires soon. New submissions pause within an hour of expiry so providers can land in-flight pieces.
      extend it to continue.
    </span>
  )
}
