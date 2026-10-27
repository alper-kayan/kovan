# Security

## Reporting a vulnerability

Write to **kovan@alperkayan.dev** (also published at `/.well-known/security.txt`). Please include
what you found, how to reproduce it and what it lets an attacker do. Do not open a public issue
for a vulnerability.

We answer within three working days, tell you whether we could reproduce it, and keep you
posted until it is fixed. We ask that you give us a reasonable time to ship a fix before you
publish, do not read or change other people's data, and do not degrade the service while
testing. Good-faith research under these terms will not be met with legal action.

## What is protected, and how

- **Your code** stays in your local clones. The server stores accounts, workspaces, membership,
  session records and transcripts, never repositories.
- **Transcripts, comments, memories and Swarm messages** are scanned for secrets before they are
  stored or sent to anyone else: provider keys, tokens, private keys, JWTs, passwords in URLs and
  `NAME=value` style credentials are replaced with `[redacted]`. This is pattern based; a secret
  in an unusual shape can get through.
- **Transcript chunks and stored GitHub tokens** are encrypted by the server (AES-256-GCM,
  rotatable keys in `ENCRYPTION_KEYS`) before they reach the database. The server holds the
  keys, so this is not end-to-end encryption.
- **Retention:** transcripts are deleted after each organization's retention time (90 days
  unless an owner changes it in Settings → Organization). A shorter time applies at once.
- **Audit log:** member, role, invite, organization, AI teammate and billing changes are
  recorded with who did them and when, kept for 400 days, and shown to organization owners.
- **Rate limits:** every API call counts against the signed-in person (600 a minute by
  default), sign-in has its own tighter limit per address, and a WebSocket that floods is closed.
- **The website and sign-in pages** are sent with a strict Content-Security-Policy (no inline or
  third-party scripts), HSTS over HTTPS, and no framing by other sites.
- **Payments:** cards are entered on Stripe's page. Kovan never sees or stores card numbers.
- **The desktop app** runs its pages sandboxed with context isolation and no Node access, and
  validates every message from them. Release builds are signed (macOS Developer ID and
  notarized, Windows Authenticode), ship with hardened Electron fuses, and only install updates
  that pass the platform's signature check, or on Linux a manifest signed with the Kovan update
  key.

## Supported versions

Only the latest release gets security fixes. The app updates itself.
