/**
 * Read-only PDPVerifier access — moved to `ipfs2foc-core/pdp-verifier` so the
 * browser console's verify-on-chain (#47) shares the exact reads `report`
 * reconciles with. Re-exported here so CLI imports keep one local path.
 */
export * from 'ipfs2foc-core/pdp-verifier'
