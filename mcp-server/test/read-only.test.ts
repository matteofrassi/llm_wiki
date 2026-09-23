import assert from "node:assert/strict"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { fileURLToPath } from "node:url"
import { LlmWikiApiClient } from "../src/api-client.js"
import { createReadOnlyServer } from "../src/index.js"

const safeHealth = { ok: true, enabled: true, mcpEnabled: true, authRequired: true, authConfigured: true, allowUnauthenticated: false, allowLanAccess: false, localOnlySearch: true }
const names = ["status", "projects", "files", "read_file", "reviews", "search", "graph"].map(n => `llm_wiki_${n}`)

async function fixture(health: Record<string, unknown> = safeHealth) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const api = new LlmWikiApiClient({ token: "fixture", fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, init })
    let result: unknown = health
    if (path.endsWith("/projects")) result = { projects: [{id:"p1", name:"Pilot",path:"/fixture/pilot",current:true},{id:"other",name:"Other",path:"/fixture/other"}], currentProject: {id:"p1",name:"Pilot",path:"/fixture/pilot",current:true} }
    if (path.endsWith("/files")) result = { files: [{name:"index.md",path:"wiki/index.md",isDir:false}],truncated:true }
    if (path.endsWith("/content")) result = { path:"wiki/index.md",content:"Evidence " + "è".repeat(90000) }
    if (path.endsWith("/reviews")) result = { status:"unresolved",reviews:[] }
    if (path.endsWith("/search")) result = { mode:"keyword",results:[{path:"wiki/concepts/example.md",title:"Example",score:1,snippet:"Source evidence"}] }
    if (path.endsWith("/graph")) result = { nodes:[],edges:[] }
    return new Response(JSON.stringify(result))
  }})
  const server = createReadOnlyServer(api, "p1")
  const client = new Client({ name:"read-only-test",version:"1" })
  const [a,b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  return { client,calls, close: async () => { await client.close(); await server.close() } }
}

test("expose exactly seven read-only tools and deny mutation calls before HTTP", async () => {
  const f=await fixture()
  try {
    const tools=(await f.client.listTools()).tools
    assert.deepEqual(tools.map(t=>t.name).sort(),names.slice().sort())
    assert.ok(tools.every(t=>t.annotations?.readOnlyHint===true && t.annotations?.openWorldHint===false))
    for (const name of ["llm_wiki_chat","llm_wiki_rescan_sources","llm_wiki_set_project","llm_wiki_embed_page"]) {
      await assert.rejects(f.client.callTool({name,arguments:{}}))
    }
    assert.equal(f.calls.length,0)
  } finally { await f.close() }
})

test("reject foreign projects, traversal, hidden state and invalid bounds before HTTP", async () => {
  const f=await fixture()
  try {
    for (const path of ["../secret","/tmp/secret","wiki/../.llm-wiki/project.json","wiki/%2e%2e/secret","wiki/.private.md","raw/sources/..\\secret","wiki//page.md"]) {
      await assert.rejects(f.client.callTool({name:"llm_wiki_read_file",arguments:{path}}))
    }
    for (const args of [{project_id:"other"},{max_files:0},{max_files:501},{max_files:1.5},{unexpected:true}]) {
      await assert.rejects(f.client.callTool({name:"llm_wiki_files",arguments:args}))
    }
    await assert.rejects(f.client.callTool({name:"llm_wiki_search",arguments:{query:"x".repeat(2001)}}))
    assert.equal(f.calls.length,0)
  } finally { await f.close() }
})

test("use only the pinned project and bounded local search while preserving citations", async () => {
  const f=await fixture()
  try {
    const projects=await f.client.callTool({name:"llm_wiki_projects",arguments:{}})
    assert.doesNotMatch(JSON.stringify(projects),/\/fixture\/other/)
    const files=await f.client.callTool({name:"llm_wiki_files",arguments:{}})
    assert.match(JSON.stringify(files),/truncated/)
    const read=await f.client.callTool({name:"llm_wiki_read_file",arguments:{path:"wiki/index.md",project_id:"current"}})
    assert.match(JSON.stringify(read),/truncated/)
    assert.ok(Buffer.byteLength(JSON.stringify(read))<130000)
    await f.client.callTool({name:"llm_wiki_reviews",arguments:{}})
    await f.client.callTool({name:"llm_wiki_graph",arguments:{}})
    const search=await f.client.callTool({name:"llm_wiki_search",arguments:{query:"evidence"}})
    assert.match(JSON.stringify(search),/wiki\/concepts\/example.md/)
    const request=f.calls.find(c=>c.path.endsWith("/search"))!
    assert.match(request.path,/projects\/p1\/search/)
    assert.deepEqual(JSON.parse(String(request.init?.body)),{query:"evidence",topK:10,includeContent:false,localOnly:true})
    assert.ok(f.calls.every(c=>c.path.endsWith("/health") || (c.init?.headers as Record<string,string>).Authorization==="Bearer fixture"))
  } finally { await f.close() }
})

test("fail closed on disabled MCP, unsafe service settings or missing local search capability", async () => {
  for (const overrides of [{mcpEnabled:false},{authRequired:false},{allowLanAccess:true},{localOnlySearch:false}]) {
    const f=await fixture({...safeHealth,...overrides})
    try {
      await assert.rejects(f.client.callTool({name:"llm_wiki_search",arguments:{query:"evidence"}}))
      assert.ok(f.calls.every(c=>c.path.endsWith("/health")))
    } finally { await f.close() }
  }
})

test("reject missing project binding", () => {
  assert.throws(()=>createReadOnlyServer(new LlmWikiApiClient({token:"fixture"}),""))
})

test("start the real stdio entrypoint without HTTP, model calls or stdout noise", async () => {
  const client=new Client({name:"stdio-test",version:"1"})
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../src/index.js",import.meta.url))],env:{LLM_WIKI_API_TOKEN:"fixture",LLM_WIKI_PROJECT_ID:"p1",LLM_WIKI_API_BASE_URL:"http://127.0.0.1:9"},stderr:"pipe"})
  try {
    await client.connect(transport)
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),names.slice().sort())
    await assert.rejects(client.callTool({name:"llm_wiki_rescan_sources",arguments:{}}))
  } finally { await client.close() }
})
