# Verify Actual Behavior

**Trigger:** Writing code, docs, or claims that depend on how an external tool, library, contract, or API behaves.

## Rule

- Read the source or run the thing before stating how it behaves.
- If the source is not available, write a probe script and observe the response shape.
- Mark unverified claims as unverified in code comments and PR descriptions.
- Confident-sounding wrong claims cost more than silence; prefer "I checked X at file:line" over recall.

## Examples

### Bad

"Curio's `pdp.addStatus` returns `ok=true` only when the AddPieces call fully succeeded."

### Good

Read `pdp/handlers.go:handleGetPieceAdditionStatus` in `filecoin-project/curio`. Confirmed: `txStatus='confirmed'` only reports tx landing. `addMessageOk` and `piecesAdded` are separate booleans. Cite the file in the code comment that interprets the response.

## Why

External APIs encode subtleties in field names that are not obvious from the name alone. The `pdp.addStatus` mistake (treating `txStatus='confirmed'` as success) silently corrupted migration state because the inner AddPieces call could fail while the tx landed.
