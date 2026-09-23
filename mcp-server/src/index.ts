#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import {
  LlmWikiApiClient,
  type ApiFileNode,
  type ApiGraphNode,
  type ApiReviewItem,
  type ApiReviewsResponse,
  type ApiSearchResult,
} from "./api-client.js"
import { VERSION } from "./version.js"
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { requireProjectBinding, validateReadOnlyArguments } from "./read-only-policy.js"

const MAX_TEXT_BYTES = 120_000

export function createReadOnlyServer(client: LlmWikiApiClient, canonicalProjectId: string): Server {
requireProjectBinding(canonicalProjectId)

const server = new Server(
  { name: "llm-wiki", version: VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "llm_wiki_status",
      description: "Check whether the LLM Wiki desktop local API is reachable and list the current project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_projects",
      description: "List known LLM Wiki projects. The response includes currentProject when the desktop app has an active project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_files",
      description: "List files from a project using the desktop app's API permissions. Use only the configured canonical project.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Configured project identifier or 'current', which always refers to the pinned project." },
          root: { type: "string", enum: ["wiki", "sources", "all"], description: "Tree root to list. Defaults to wiki." },
          recursive: { type: "boolean", description: "Whether to list recursively. Defaults to true." },
          max_files: { type: "integer", minimum: 1, maximum: 500, description: "Maximum files returned. Range 1-500; default 200." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_read_file",
      description: "Read a text file from a project through the desktop app API. Only public project paths such as wiki/ and raw/sources/ are allowed by the API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Configured project identifier or 'current', which always refers to the pinned project." },
          path: { type: "string", description: "Project-relative file path, for example wiki/index.md." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_reviews",
      description: "List Review tab items from a project. Defaults to unresolved items so agent clients can help manage pending wiki review work.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Configured project identifier or 'current', which always refers to the pinned project." },
          status: { type: "string", enum: ["unresolved", "resolved", "all"], description: "Review status filter. Defaults to unresolved." },
          type: { type: "string", description: "Optional Review item type filter, for example missing-page, duplicate, contradiction, confirm, or suggestion." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum review items returned. The local API clamps to its configured maximum." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_search",
      description: "Search the canonical project locally by keywords and graph; never call an embedding or language-model provider.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Configured project identifier or 'current', which always refers to the pinned project." },
          query: { type: "string", description: "Search query." },
          top_k: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results. The local API clamps to its configured maximum." },
          include_content: { type: "boolean", description: "Include full page content in results when supported by the API." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },

    {
      name: "llm_wiki_graph",
      description: "Query the project knowledge graph through the desktop app API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Configured project identifier or 'current', which always refers to the pinned project." },
          q: { type: "string", description: "Optional text filter." },
          node_type: { type: "string", description: "Optional node type filter." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum nodes. The local API clamps to its configured maximum." },
        },
        additionalProperties: false,
      },
    },

  ].map(tool => ({...tool, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}})),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = asObject(request.params.arguments ?? {})
  try {
    validateReadOnlyArguments(request.params.name, args, canonicalProjectId)
    switch (request.params.name) {
      case "llm_wiki_status": {
        const health = await client.health()
        return textResult(JSON.stringify({enabled:health.enabled === true, mcpEnabled:health.mcpEnabled === true, authRequired:health.authRequired === true, allowLanAccess:health.allowLanAccess, localOnlySearch:health.localOnlySearch === true, canonicalProjectId}, null, 2))
      }
      case "llm_wiki_projects": {
        await assertMcpEnabled()
        const projects = await client.projects()
        return textResult(JSON.stringify({projects:projects.projects.filter(p=>p.id===canonicalProjectId),currentProject:projects.currentProject?.id===canonicalProjectId ? projects.currentProject : null}, null, 2))
      }
      case "llm_wiki_files": {
        await assertMcpEnabled()
        const response = await client.files(canonicalProjectId, {
          root: enumArg(args.root, ["wiki", "sources", "all"] as const, "wiki"),
          recursive: boolArg(args.recursive, true),
          maxFiles: numberArg(args.max_files) ?? 200,
        })
        return textResult(formatFileTree(response.files, response.truncated))
      }
      case "llm_wiki_read_file": {
        await assertMcpEnabled()
        const relPath = stringArg(args.path, "path")
        const { path, content } = await client.fileContent(canonicalProjectId, relPath)
        return textResult(`# ${path}\n\n${truncateText(content, MAX_TEXT_BYTES)}`)
      }
      case "llm_wiki_reviews": {
        await assertMcpEnabled()
        const reviews = await client.reviews(canonicalProjectId, {
          status: enumArg(args.status, ["unresolved", "resolved", "all"] as const, "unresolved"),
          type: optionalStringArg(args.type),
          limit: numberArg(args.limit) ?? 50,
        })
        return textResult(formatReviews(reviews))
      }
      case "llm_wiki_search": {
        await assertMcpEnabled(true)
        const query = stringArg(args.query, "query")
        const search = await client.search(canonicalProjectId, query, {
          topK: numberArg(args.top_k) ?? 10,
          includeContent: boolArg(args.include_content, false),
          localOnly: true,
        })
        return textResult(formatSearchResults(query, search))
      }

      case "llm_wiki_graph": {
        await assertMcpEnabled()
        const graph = await client.graph(canonicalProjectId, {
          q: optionalStringArg(args.q),
          nodeType: optionalStringArg(args.node_type),
          limit: numberArg(args.limit) ?? 100,
        })
        return textResult(formatGraph(graph.nodes, graph.edges))
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, "Tool unavailable in the read-only profile")
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error && err.message.startsWith("LLM Wiki API ") ? err.message : "LLM Wiki read-only operation failed",
    )
  }
})

async function assertMcpEnabled(localSearch = false): Promise<void> {
  const health = await client.health()
  if (health.enabled !== true || health.mcpEnabled !== true || health.authRequired !== true || health.authConfigured !== true || health.allowUnauthenticated !== false || health.allowLanAccess !== false) {
    throw new McpError(ErrorCode.InvalidRequest, "Require enabled, authenticated, loopback-only MCP access in the application")
  }
  if (localSearch && health.localOnlySearch !== true) throw new McpError(ErrorCode.InvalidRequest, "Update the application before using deterministic local search")
}
return server
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text: truncateText(text, MAX_TEXT_BYTES) }],
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}


function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`)
  }
  return value
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback
}


function truncateText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= maxBytes) return value
  let out = ""
  let used = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return `${out}\n\n[truncated: ${bytes - used} bytes omitted]`
}

function formatFileTree(files: ApiFileNode[], truncated = false): string {
  if (files.length === 0) return "No files found."
  const lines: string[] = truncated
    ? ["[warning] File tree was truncated by the LLM Wiki API maxFiles limit.", ""]
    : []
  const walk = (nodes: ApiFileNode[], depth: number) => {
    for (const node of nodes) {
      const prefix = "  ".repeat(depth)
      lines.push(`${prefix}${node.isDir ? "📁" : "📄"} ${node.path}`)
      if (node.children) walk(node.children, depth + 1)
    }
  }
  walk(files, 0)
  return lines.join("\n")
}

function formatSearchResults(query: string, search: { results: ApiSearchResult[]; mode?: string; tokenHits?: number; vectorHits?: number }): string {
  const { results } = search
  if (results.length === 0) return `No results for "${query}".`
  const meta = [
    search.mode ? `Mode: ${search.mode}` : null,
    typeof search.tokenHits === "number" ? `Token hits: ${search.tokenHits}` : null,
    typeof search.vectorHits === "number" ? `Vector hits: ${search.vectorHits}` : null,
  ].filter(Boolean)
  const lines = [`# Search results for "${query}"`, ...(meta.length > 0 ? [meta.join(" | ")] : []), ""]
  results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.title}`)
    lines.push(`Path: ${result.path}`)
    lines.push(`Score: ${result.score.toFixed(6)}${typeof result.vectorScore === "number" ? ` | Vector score: ${result.vectorScore.toFixed(6)}` : ""}`)
    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)
    if (result.images && result.images.length > 0) {
      lines.push(`Images: ${result.images.map((image) => image.url).join(", ")}`)
    }
    lines.push("")
  })
  return lines.join("\n")
}


function formatReviews(response: ApiReviewsResponse): string {
  const { reviews } = response
  if (reviews.length === 0) return `No ${response.status} review items found.`
  const lines = [
    "# Review items",
    "",
    `Status: ${response.status}`,
    `Count: ${response.count}`,
    "",
  ]
  reviews.forEach((review, index) => {
    lines.push(`## ${index + 1}. ${review.title || review.id}`)
    lines.push(`ID: ${review.id}`)
    lines.push(`Type: ${review.type}`)
    lines.push(`Resolved: ${review.resolved ? "yes" : "no"}`)
    if (review.sourcePath) lines.push(`Source: ${review.sourcePath}`)
    if (review.affectedPages && review.affectedPages.length > 0) {
      lines.push(`Affected pages: ${review.affectedPages.join(", ")}`)
    }
    if (review.searchQueries && review.searchQueries.length > 0) {
      lines.push(`Search queries: ${review.searchQueries.join(", ")}`)
    }
    if (review.description) lines.push(`Description: ${review.description}`)
    const optionSummary = formatReviewOptions(review)
    if (optionSummary) lines.push(`Options: ${optionSummary}`)
    lines.push("")
  })
  return lines.join("\n")
}

function formatReviewOptions(review: ApiReviewItem): string {
  if (!review.options || review.options.length === 0) return ""
  return review.options
    .map((option) => option.label ? `${option.label} (${option.action})` : option.action)
    .join(", ")
}

function formatGraph(nodes: ApiGraphNode[], edges: Array<{ source: string; target: string; weight?: number }>): string {
  const typeCounts = new Map<string, number>()
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1)
  const lines = [
    "# Knowledge graph",
    "",
    `Nodes: ${nodes.length}`,
    `Edges: ${edges.length}`,
    "",
    "## Node types",
    ...[...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Top nodes",
    ...nodes
      .slice()
      .sort((a, b) => (b.linkCount ?? 0) - (a.linkCount ?? 0))
      .slice(0, 30)
      .map((node) => `- ${node.label} (${node.type}, ${node.linkCount ?? 0} links)${node.path ? ` — ${node.path}` : ""}`),
  ]
  return lines.join("\n")
}

async function main(): Promise<void> {
  if (!process.env.LLM_WIKI_API_TOKEN?.trim()) throw new Error("missing_token")
  const server = createReadOnlyServer(new LlmWikiApiClient(), process.env.LLM_WIKI_PROJECT_ID ?? "")
  await server.connect(new StdioServerTransport())
  console.error(`LLM Wiki read-only MCP v${VERSION} ready`)
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error("LLM Wiki MCP startup failed; check the approved local launcher and project configuration")
    process.exitCode = 1
  })
}
