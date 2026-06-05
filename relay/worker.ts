/**
 * Cloudflare Worker entry for the ipfs2foc redirect relay.
 *
 * A Worker entry module may export only handlers (workerd rejects plain value
 * exports), so all logic and types live in `./handler.ts` and this file just
 * wires the request handler in as `fetch`. The relay is stateless — the only
 * binding is the optional `ALLOWED_GATEWAY_HOSTS` var.
 */
import { handle, type RelayEnv } from './handler.ts'

export default {
  fetch(request: Request, env: RelayEnv): Response {
    return handle(request, env)
  },
}
