# LLM Wiki Read-Only MCP

Use the existing desktop API; do not duplicate its project registry, search engine, graph or source state in MCP. Keep this component deterministic (`no-llm`) and restricted to one canonical project.

## Runtime Contract

- Expose exactly `llm_wiki_status`, `llm_wiki_projects`, `llm_wiki_files`, `llm_wiki_read_file`, `llm_wiki_reviews`, `llm_wiki_search` and `llm_wiki_graph`.
- Reject chat, rescan, ingest, project switching and every other tool name server-side before HTTP. Do not add a full-access profile implicitly.
- Require Node.js 20+, the verified custom app and `LLM_WIKI_PROJECT_ID` containing its registry identifier. Bind `current` to that fixed identifier, never to whichever project the UI later opens. Return only matching project metadata.
- Inject `LLM_WIKI_API_TOKEN` through the approved Keychain profile launcher. Do not put tokens in client configuration, command arguments, documentation or shell exports. Keep launcher registration and OpenCode activation behind the migration plan's gates.
- Accept only HTTP loopback origins. Normalize `localhost` to `127.0.0.1`; default to port 19828. Reject credentials, paths, query strings, non-loopback hosts and redirects in `LLM_WIKI_API_BASE_URL`.
- Before data tools, require an enabled, authenticated MCP API with unauthenticated access and LAN access explicitly disabled. Keep status diagnostic-only; never treat a failed read as an empty successful result.
- Read only visible relative paths under `wiki/` and `raw/sources/`. Reject traversal, encoded paths, hidden entries and backslashes before HTTP; retain the desktop API's canonical-path and symlink checks.
- Send search with `localOnly: true`. Require the app's `localOnlySearch` capability first, so old binaries cannot silently ignore the flag and invoke an embedding provider. Reuse local keyword/graph retrieval, preserve citations and expose the actual retrieval mode. Keep existing direct desktop/API search behavior unchanged when `localOnly` is omitted. Do not claim semantic parity until the pilot benchmark passes.

## Bounds And Failure Behavior

Limit files to 500 (default 200), search results to 20 (default 10), reviews to 100 (default 50), graph nodes to 200 (default 100), and query/filter strings to 2,000 characters. Limit each HTTP response to 2 MB and each tool's text to 120 KB with explicit truncation. Include headers and response-body reads in the 30-second request deadline. Preserve project-relative citation paths in search results.

Report HTTP status or a bounded local error category, never a raw response body, token, configured URL or upstream exception text. Write diagnostics to stderr only. Perform no automatic retry, provider fallback or source mutation.

## Validation And Activation

Run `npm test` in this directory. Reuse its TypeScript build, API fixtures, in-memory MCP tests and actual stdio handshake. Run the backend's targeted `local_only_search_never_resolves_provider_or_explicit_embeddings` test before packaging the app.

Treat passing mocked tests as component evidence only. Complete the app build, Keychain launcher, independent security/code release review, pilot retrieval/update benchmark and approved temporary OpenCode configuration before activation. Keep the installed application and corpus untouched during source-level validation.
