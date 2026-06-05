// IndexedDB persistence for the prepare run (#26). A refresh, accidental tab
// close, or a discarded idle tab no longer loses the CID list or the computed
// pieces — on load the app restores them and recomputes only what's missing.
// Computed pieces are deterministic, so restoring a done row is always safe.
//
// IndexedDB over localStorage: result sets grow with the CID list, and a future
// per-piece byte cache needs more than string storage. Everything is
// best-effort — private windows and storage-denied contexts degrade to the
// old non-persistent behavior, never to an error the user sees.
import type { PieceResult } from './commp.ts'

const DB_NAME = 'ipfs2foc'
const STORE = 'prepare-run'
const KEY = 'current'

export interface SavedRun {
  cidsText: string
  gateway: string
  relayBase: string
  /** Completed pieces keyed by the CID string as the user entered it. */
  results: Record<string, PieceResult>
  updatedAt: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function loadRun(): Promise<SavedRun | null> {
  try {
    return ((await withStore('readonly', (s) => s.get(KEY))) as SavedRun | undefined) ?? null
  } catch {
    return null
  }
}

export async function saveRun(run: SavedRun): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.put(run, KEY))
  } catch {
    // best-effort: storage denied or private window
  }
}

export async function clearRun(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(KEY))
  } catch {
    // best-effort
  }
}
