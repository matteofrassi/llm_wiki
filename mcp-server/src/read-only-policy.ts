import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"

export const READ_ONLY_TOOLS = new Set([
  "llm_wiki_status", "llm_wiki_projects", "llm_wiki_files", "llm_wiki_read_file",
  "llm_wiki_reviews", "llm_wiki_search", "llm_wiki_graph",
])

const fields: Record<string, readonly string[]> = {
  llm_wiki_status: [], llm_wiki_projects: [],
  llm_wiki_files: ["project_id", "root", "recursive", "max_files"],
  llm_wiki_read_file: ["project_id", "path"],
  llm_wiki_reviews: ["project_id", "status", "type", "limit"],
  llm_wiki_search: ["project_id", "query", "top_k", "include_content"],
  llm_wiki_graph: ["project_id", "q", "node_type", "limit"],
}

function invalid(message: string): never { throw new McpError(ErrorCode.InvalidParams, message) }

export function requireProjectBinding(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId) || projectId === "current") {
    throw new Error("Configure LLM_WIKI_PROJECT_ID with the canonical project identifier")
  }
}

export function validateReadOnlyArguments(name: string, args: Record<string, unknown>, projectId: string): void {
  if (!READ_ONLY_TOOLS.has(name)) throw new McpError(ErrorCode.MethodNotFound, "Tool unavailable in the read-only profile")
  if (Object.keys(args).some(key => !fields[name]!.includes(key))) invalid("Unexpected tool argument")
  if (args.project_id !== undefined && args.project_id !== projectId && args.project_id !== "current") invalid("Project differs from the configured canonical project")
  for (const key of ["recursive", "include_content"]) if (args[key] !== undefined && typeof args[key] !== "boolean") invalid(`Invalid ${key}`)
  for (const [key, allowed] of [["root", ["wiki", "sources", "all"]], ["status", ["unresolved", "resolved", "all"]]] as const) {
    if (args[key] !== undefined && !allowed.some(v=>v===args[key])) invalid(`Invalid ${key}`)
  }
  for (const [key,max] of [["max_files",500],["top_k",20],["limit",name==="llm_wiki_graph"?200:100]] as const) {
    if (args[key] !== undefined && (typeof args[key]!=="number" || !Number.isInteger(args[key]) || (args[key] as number)<1 || (args[key] as number)>max)) invalid(`${key} must be an integer from 1 to ${max}`)
  }
  for (const key of ["query","q","type","node_type"]) {
    if (args[key] !== undefined && (typeof args[key]!=="string" || !(args[key] as string).trim() || (args[key] as string).length>2000 || /[\u0000-\u001f\u007f]/u.test(args[key] as string))) invalid(`Invalid ${key}`)
  }
  if (name==="llm_wiki_search" && args.query===undefined) invalid("query is required")
  if (name==="llm_wiki_read_file") {
    const value=args.path
    if (typeof value!=="string" || value.length>2048 || !/^(wiki|raw\/sources)\//.test(value) || /[%\\\u0000-\u001f\u007f]/u.test(value) || value.split("/").some(part=>!part || part.startsWith("."))) {
      invalid("Use a visible project-relative file under wiki/ or raw/sources/")
    }
  }
}
