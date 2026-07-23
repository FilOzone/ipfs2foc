/**
 * The signing-session explainers. What the one wallet approval authorizes,
 * stated before the user grants it, and the expiry warning once a session is
 * close to lapsing.
 */

/** Shown before the grant: exactly what the wallet popup asks and what the temporary key can do. */
export function SessionGrantExplainer({ availableLabel, longWindow }: { availableLabel: string; longWindow: boolean }) {
  return (
    <span className="pay-setup">
      Clicking Enable signing opens one wallet approval. It authorizes a temporary key, created and stored in this
      browser, to sign the migration steps for the chosen window: it can create data sets and add pieces, spending from
      the {availableLabel} available, and nothing else: no removals, no withdrawals. It expires on its own at the end of
      the window, and you can revoke it here sooner.
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
      Extend it to continue.
    </span>
  )
}
