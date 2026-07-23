/** Display formatting shared by the app shell and its extracted components. */

/** A duration an operator plans around — nearest useful unit, no precision theater. */
export function fmtEta(seconds: number): string {
  if (seconds < 90) return 'under 2 minutes'
  const minutes = seconds / 60
  if (minutes < 90) return `about ${Math.round(minutes)} minutes`
  const hours = minutes / 60
  if (hours < 36) {
    const h = Math.round(hours)
    return `about ${h} hour${h === 1 ? '' : 's'}`
  }
  const d = Math.round(hours / 24)
  return `about ${d} day${d === 1 ? '' : 's'}`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

/** A configured ceiling reads as a round figure: "1 GiB", "100 MiB". */
export function fmtLimitBytes(n: number): string {
  const gib = 1024 * 1024 * 1024
  if (n % gib === 0) return `${n / gib} GiB`
  return `${Math.round(n / (1024 * 1024))} MiB`
}

export function short(s: string, head = 10, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function fmtExpiry(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
