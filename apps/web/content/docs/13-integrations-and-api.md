# Integrations and the API

Other systems can start work in Kovan and follow it: an issue tracker that hands a task to an agent, a chat bot that reports when a session ends. Owners set this up in the desktop app.

## Where

- **Settings → Organization → Integrations** works for every workspace of the organization, including ones made later. This is usually what you want.
- **Settings → Workspaces → Integrations** does the same for one workspace only.

## API keys

A key (it starts with `kv_live_`) is shown once, when it's made: keep it somewhere safe. It acts as a member of its own, so it keeps working when people leave, and it can never change members, settings or billing. Pick only the scopes it needs:

| Scope      | What it may do                                        |
| ---------- | ----------------------------------------------------- |
| `read`     | Read workspaces, sessions, plans and the event stream |
| `dispatch` | Start sessions and send work to agents                |
| `control`  | Stop, steer and reassign running work                 |
| `machine`  | Run as a [machine](/docs/machines/) that takes work   |

Send it as `Authorization: Bearer kv_live_…`.

## Webhooks

A webhook sends Kovan's events to an address of yours as they happen. Its secret is shown once; each delivery carries an `x-kovan-signature` header, `sha256=` followed by the HMAC-SHA256 of the body with that secret, so you can check it came from Kovan. **Send test** posts a sample, and the delivery log shows what was sent and what your server answered.

## The event stream

Without a server of your own, read the same events with a key: `GET /api/workspaces/<id>/events?since=<cursor>&wait=25` waits up to 25 seconds for new ones and returns a cursor for the next call. The organization has the same at `/api/orgs/<id>/events`.
