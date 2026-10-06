# Backlog

## Active

- [ ] Expose canonical source ingest status in the Sources view and local API using the ingest cache, queue, content hash, and legacy summary resolution.
- [ ] Move the ingest request queue behind a backend-owned persistent boundary before exposing a bounded API endpoint for up to 10 canonicalized `raw/sources/` files.
- [ ] Expose source status and backend-confirmed ingest queue operations through the bundled MCP server.
- [ ] Complete the approved Keychain launcher, independent security/code release review and packaged-app verification before connecting the read-only MCP to OpenCode. Reuse the 2026-09-23 evidence: 24 MCP tests and 28 API tests PASS; keep activation and pilot gates in the migration owner's canonical plan.
- [ ] Verify the configured display name `LLM Wiki Metfras` and preserved bundle identifier `com.metfras.llmwiki` in the next packaged release.
- [ ] Produce a signed custom-app release and validate it with a one-source canary before the next nine-source batch.

## Deferred

- [ ] Complete draft PR #6 cloud checks, obtain explicit merge approval, preserve both histories during default-branch integration, and verify the update-preparation `current` state. Reuse the completed code/security review and `pending_review` cloud test; keep packaged-release/adoption gates in `UPSTREAM_MAINTENANCE.md`.
- [ ] Retire local patches only when upstream provides verified equivalents; follow `UPSTREAM_MAINTENANCE.md`.
