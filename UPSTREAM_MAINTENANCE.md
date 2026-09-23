# Maintain the LLM Wiki fork

Keep upstream history intact. Merge stable releases into a candidate branch, preserve the local controls below, and review one candidate at a time. Never automatically install, deploy, tag, release, or merge an update.

## Retain these local controls

| Control | Owner and evidence | Remove only when |
|---|---|---|
| Keep credentials in macOS Keychain, including custom HTTP headers | `src/lib/keychain-config.ts`, `src-tauri/src/keychain.rs`, configuration/persistence tests | Upstream supplies equivalent storage and a verified migration |
| Block automatic project opening with persisted plaintext secrets | `src/App.tsx`, `findPersistedPlaintextSecrets`, project-store tests | Equivalent startup protection passes the same failure scenarios |
| Require authenticated loopback access and exactly seven read-only, project-bound MCP tools | `src-tauri/src/api_server.rs`, `mcp-server/src/read-only-policy.ts`, MCP/API tests | Equivalent authentication, no-LLM retrieval and mutation denial pass |
| Preserve configured CLI isolation and fail closed for invalid proxy configuration | `src-tauri/src/commands/codex_cli.rs`, `src/lib/connection-tests.ts`, `src-tauri/src/proxy.rs` and tests | Equivalent OS authentication, sandbox and network behavior pass |
| Preserve index categories and meaningful append-only ingest logs | `src/lib/ingest.ts`, ingest parser/scenario tests | Equivalent deterministic behavior passes without extra model calls |
| Keep custom app identity and exclude the browser clipper | `src-tauri/tauri.conf.json`, native registration, MCP README | Explicitly approve the replacement behavior |

Treat passing tests as necessary evidence, not proof that every future change preserves these controls. Review the candidate diff before acceptance. Reject or adapt upstream features that weaken them.

## Prepare updates automatically

Run **Prepare upstream update** weekly on Monday at 07:23 UTC, or manually from GitHub Actions. Run it from the default branch. Use the latest published stable `vX.Y.Z` release and record its exact commit identifier; ignore prereleases. Do not use a model to decide merges.

1. Compare the stable release with the fork. Stop without building when already integrated, when another candidate is open, or when this exact candidate was previously reviewed and closed.
2. Merge in a disposable runner. Preserve both histories. Stop and retain a bounded report if conflicts occur; never select either side automatically.
3. Require manual attention for changed `.github/`, `.gitmodules` or `.gitattributes` files before executing or publishing that candidate.
4. Validate the exact candidate on a separate macOS runner with read-only repository access and no provider credentials. Run frontend typecheck/build, mock tests, MCP tests and native tests. Do not run `npm test` at the repository root: it includes real-model tests.
5. Recheck the default branch and candidate identifiers. Publish one draft pull request only after validation passes. Refuse to overwrite an existing changed candidate branch. Keep the publisher on trusted baseline code and do not execute candidate code with write access.

Reuse `.github/workflows/validate.yml` for ordinary CI and upstream preparation. Keep automatic update validation to macOS, the installed target; preserve Linux/Windows build checks in ordinary PR CI. Do not rely on a bot-created PR to start required tests automatically.

Use only the built-in, job-scoped GitHub token. Keep repository default workflow permission at **read**. Grant `contents: write` and `pull-requests: write` only to the publication job. Enable the repository option allowing Actions to create pull requests when activating this workflow; do not add a personal access token or auto-approval/auto-merge step.

Retain reports and candidate bundles for 14 days. Use GitHub Actions failure notifications for conflicts and failed checks; inspect the job summary and `candidate.json`. Expect no draft when nothing changes. GitHub may delay scheduled runs or disable them after prolonged repository inactivity; retain manual dispatch as the recovery path.

## Accept or defer a candidate

- Review upstream changes by affected subsystem, with particular attention to the retained controls, persistence, raw-source preservation and API surface. Do not audit 154 commits independently when a coherent cumulative diff and targeted tests provide better evidence.
- Require the project's independent release review, packaged-app checks and approved source canaries before adoption. Test with disposable data first. Confirm the saved source watcher before launching; do not trigger unintended ingestion.
- Merge only after acceptance. Use a normal merge, not a squash or rebase, so future ancestry checks recognize the upstream release. Keep the previous installed bundle available until the new version is accepted; do not rebuild over its linked release path during candidate testing.
- If conflicts, workflow changes or failed tests stop automation, resolve them in an isolated checkout, rerun affected validation and open a reviewed candidate manually. Do not weaken guards to make the update pass.
- If publication is interrupted after pushing but before PR creation, rerun. Reproduce the same merge identifier from fixed input commits and metadata, reuse the identical branch, and reject a changed branch. If a candidate was deliberately closed, handle any reconsideration manually instead of reopening it every week.
- Reconsider the fork only when all retained controls have suitable upstream equivalents and a tested migration preserves credentials, app identity and project data. Retire patches individually; do not abandon the fork merely because a newer version exists.

## Initial v0.6.11 candidate

Preserve baseline `c91876300bb4a124bfd8a6d1bfe8ff371fc0d5c7` and integrate upstream `e8082119649e6a8e1cf85eaf289adcabfdf39d4e` (154 previously unintegrated commits). Retain the four scoped commits consolidating ingestion, CLI routing, MCP/API controls and app identity. Resolve merge conflicts without replacing the installed v0.6.4 application.

Record the 2026-09-23 local validation: frontend build/typecheck PASS; 1,891 mock tests PASS; 30 MCP tests PASS; 404 native tests PASS, with two preexisting manual corpus probes ignored; eight update-safety tests PASS. Keep cloud-run status, packaged runtime and independent release review separate from local test results.

Use the migration owner's existing completion plan for activation, pilot acceptance, source migration and legacy retirement. Do not duplicate those steps here or consider the old knowledge Favorite removable before that plan passes.

References: [GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), [scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
