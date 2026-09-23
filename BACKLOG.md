# Backlog

## Active

- [ ] Expose canonical source ingest status in the Sources view and local API using the ingest cache, queue, content hash, and legacy summary resolution.
- [ ] Move the ingest request queue behind a backend-owned persistent boundary before exposing a bounded API endpoint for up to 10 canonicalized `raw/sources/` files.
- [ ] Expose source status and backend-confirmed ingest queue operations through the bundled MCP server.
- [ ] Complete the approved Keychain launcher, independent security/code release review and packaged-app verification before connecting the read-only MCP to OpenCode. Reuse the 2026-09-23 evidence: 24 MCP tests and 28 API tests PASS; keep activation and pilot gates in the migration owner's canonical plan.
- [ ] Rename the custom application display name to `LLM Wiki Metfras` while retaining bundle identifier `com.metfras.llmwiki`.
- [ ] Produce a signed custom-app release and validate it with a one-source canary before the next nine-source batch.

## Deferred

- [ ] Commit verified local changes after explicit approval.
- [ ] Integrate future upstream updates into the fork after reviewing conflicts and rerunning the full test suite.
