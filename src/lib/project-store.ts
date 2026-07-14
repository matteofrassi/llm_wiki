import { load } from "@tauri-apps/plugin-store"
import { invoke } from "@tauri-apps/api/core"
import type { WikiProject } from "@/types/wiki"
import type { ApiConfig, GeneralConfig, LlmConfig, SearchApiConfig, EmbeddingConfig, MineruConfig, MultimodalConfig, OutputLanguage, ProviderConfigs, ProxyConfig, ScheduledImportConfig, SourceWatchConfig } from "@/stores/wiki-store"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { normalizePath } from "@/lib/path-utils"
import { DEFAULT_ZOOM_LEVEL, clampZoomLevel } from "@/stores/zoom-store"
import { plaintextSecretPaths, redactConfigSecrets, type StoredConfig } from "@/lib/keychain-config"

const STORE_NAME = "app-state.json"
const KEYCHAIN_MANAGED_KEYS = "keychainManagedKeys"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_PROJECT_KEY = "lastProject"

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

async function syncKeychainEntries(
  store: Awaited<ReturnType<typeof getStore>>,
  scope: string,
  entries: Record<string, string>,
): Promise<void> {
  const managed = (await store.get<Record<string, string[]>>(KEYCHAIN_MANAGED_KEYS)) ?? {}
  const previous = managed[scope] ?? []
  const merged: Record<string, string> = {}
  for (const key of previous) merged[key] = entries[key] ?? ""
  Object.assign(merged, entries)
  await invoke<void>("keychain_sync", { entries: merged })
  await store.set(KEYCHAIN_MANAGED_KEYS, { ...managed, [scope]: Object.keys(entries) })
}

async function saveSecureConfig<T>(key: string, value: T): Promise<void> {
  // A user save is the only flow allowed to revoke a Keychain entry by
  // sending an explicit empty value.
  const { config, secrets } = redactConfigSecrets({ [key]: value })
  const store = await getStore()
  await syncKeychainEntries(store, key, secrets)
  await store.set(key, config[key])
}

async function loadSecureConfig<T>(key: string): Promise<T | null> {
  const store = await getStore()
  const value = await store.get<T>(key)
  if (value === null || value === undefined) return null

  // A load migrates legacy plaintext only. It must not interpret a redacted
  // empty field as the user explicitly revoking an existing Keychain entry.
  const { config, secrets } = redactConfigSecrets({ [key]: value }, false)
  if (Object.keys(secrets).length > 0) {
    await syncKeychainEntries(store, key, secrets)
    await store.set(key, config[key])
    await store.save()
  }
  const hydrated = await invoke<StoredConfig>("keychain_hydrate_config", { config })
  return (hydrated[key] as T | undefined) ?? null
}

export async function getRecentProjects(): Promise<WikiProject[]> {
  const store = await getStore()
  const projects = await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)
  return projects ?? []
}

export async function getLastProject(): Promise<WikiProject | null> {
  const store = await getStore()
  const project = await store.get<WikiProject>(LAST_PROJECT_KEY)
  return project ?? null
}

export async function saveLastProject(project: WikiProject): Promise<void> {
  const store = await getStore()
  await store.set(LAST_PROJECT_KEY, project)
  await addToRecentProjects(project)
  await store.save()
  // The Rust API caches app-state for five seconds. Explicitly clear that
  // cache after the persisted project pointer changes so `current` cannot
  // resolve to the project that was open immediately before this one.
  await invoke<string>("api_server_reload_config")
}

export async function addToRecentProjects(
  project: WikiProject
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const filtered = existing.filter((p) => p.path !== project.path)
  const updated = [project, ...filtered].slice(0, 10)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LLM_CONFIG_KEY = "llmConfig"
const PROVIDER_CONFIGS_KEY = "providerConfigs"
const ACTIVE_PRESET_KEY = "activePresetId"

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  await saveSecureConfig(LLM_CONFIG_KEY, config)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  return loadSecureConfig<LlmConfig>(LLM_CONFIG_KEY)
}

export async function saveProviderConfigs(configs: ProviderConfigs): Promise<void> {
  await saveSecureConfig(PROVIDER_CONFIGS_KEY, configs)
}

export async function loadProviderConfigs(): Promise<ProviderConfigs | null> {
  return loadSecureConfig<ProviderConfigs>(PROVIDER_CONFIGS_KEY)
}

export async function saveActivePresetId(id: string | null): Promise<void> {
  const store = await getStore()
  await store.set(ACTIVE_PRESET_KEY, id)
}

export async function loadActivePresetId(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string | null>(ACTIVE_PRESET_KEY)) ?? null
}

const SEARCH_API_KEY = "searchApiConfig"

export async function saveSearchApiConfig(config: SearchApiConfig): Promise<void> {
  await saveSecureConfig(SEARCH_API_KEY, config)
}

export async function loadSearchApiConfig(): Promise<SearchApiConfig | null> {
  return loadSecureConfig<SearchApiConfig>(SEARCH_API_KEY)
}

const EMBEDDING_KEY = "embeddingConfig"

export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  await saveSecureConfig(EMBEDDING_KEY, config)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  return loadSecureConfig<EmbeddingConfig>(EMBEDDING_KEY)
}

const MULTIMODAL_KEY = "multimodalConfig"

export async function saveMultimodalConfig(config: MultimodalConfig): Promise<void> {
  await saveSecureConfig(MULTIMODAL_KEY, config)
}

export async function loadMultimodalConfig(): Promise<MultimodalConfig | null> {
  return loadSecureConfig<MultimodalConfig>(MULTIMODAL_KEY)
}

const MINERU_KEY = "mineruConfig"

function normalizeMineruConfig(config: MineruConfig): MineruConfig {
  return {
    enabled: config.enabled === true,
    token: typeof config.token === "string" ? config.token : "",
    modelVersion: config.modelVersion === "pipeline" ? "pipeline" : "vlm",
  }
}

function normalizeZoomLevel(level: unknown): number {
  return typeof level === "number" && Number.isFinite(level)
    ? clampZoomLevel(level)
    : DEFAULT_ZOOM_LEVEL
}

export const __projectStoreTest = {
  normalizeMineruConfig,
  normalizeZoomLevel,
}

export async function saveMineruConfig(config: MineruConfig): Promise<void> {
  await saveSecureConfig(MINERU_KEY, normalizeMineruConfig(config))
}

export async function loadMineruConfig(): Promise<MineruConfig | null> {
  const config = await loadSecureConfig<MineruConfig>(MINERU_KEY)
  return config ? normalizeMineruConfig(config) : null
}

// IMPORTANT: Keep this key in sync with the Rust setup hook
// (src-tauri/src/proxy.rs), which reads this exact field name from
// the same `app-state.json` store at app launch to translate the
// config into HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars.
const PROXY_CONFIG_KEY = "proxyConfig"

export async function saveProxyConfig(config: ProxyConfig): Promise<void> {
  await saveSecureConfig(PROXY_CONFIG_KEY, config)
  const store = await getStore()
  // Force-flush to disk. The store is opened with `autoSave: true`,
  // which is a 100ms debounce — not an immediate write. For most
  // settings that's fine, but the proxy config is on the startup
  // critical path: the Rust setup hook reads `app-state.json` on
  // launch to apply HTTP_PROXY / HTTPS_PROXY / NO_PROXY. If the
  // user saves and quits within the debounce window the disk
  // value would lag behind in-memory, and the next launch would
  // boot with the wrong proxy.
  await store.save()
}

export async function loadProxyConfig(): Promise<ProxyConfig | null> {
  return loadSecureConfig<ProxyConfig>(PROXY_CONFIG_KEY)
}

// Local API server config. KEY MUST stay `apiConfig` — the Rust
// `api_server` module reads `parsed.get("apiConfig")` from this same
// `app-state.json` on every request (5s cache). Rename one side and
// the API silently goes back to "no token configured = 401 forever".
const API_CONFIG_KEY = "apiConfig"
const SECURE_CONFIG_KEYS = [
  LLM_CONFIG_KEY,
  PROVIDER_CONFIGS_KEY,
  SEARCH_API_KEY,
  EMBEDDING_KEY,
  MULTIMODAL_KEY,
  MINERU_KEY,
  PROXY_CONFIG_KEY,
  API_CONFIG_KEY,
]

export async function findPersistedPlaintextSecrets(): Promise<string[]> {
  const store = await getStore()
  const config: StoredConfig = {}
  for (const key of SECURE_CONFIG_KEYS) {
    const value = await store.get<unknown>(key)
    if (value !== null && value !== undefined) config[key] = value
  }
  return plaintextSecretPaths(config)
}

export async function saveApiConfig(config: ApiConfig): Promise<void> {
  await saveSecureConfig(API_CONFIG_KEY, config)
  const store = await getStore()
  // Force-flush. The 100ms debounce default is fine for cosmetic
  // settings, but the API token is on a security hot path — a user
  // generates one, hits Save, then immediately curls the API from
  // another terminal. We want the disk file to match in-memory
  // state before the next request reads it.
  await store.save()
}

export async function loadApiConfig(): Promise<ApiConfig | null> {
  return loadSecureConfig<ApiConfig>(API_CONFIG_KEY)
}

const GENERAL_CONFIG_KEY = "generalConfig"

export const DEFAULT_GENERAL_CONFIG: GeneralConfig = {
  autostart: false,
  closeBehavior: "minimize",
}

export function normalizeGeneralConfig(config?: Partial<GeneralConfig> | null): GeneralConfig {
  const closeBehavior = config?.closeBehavior
  return {
    autostart: typeof config?.autostart === "boolean" ? config.autostart : DEFAULT_GENERAL_CONFIG.autostart,
    closeBehavior:
      closeBehavior === "ask" || closeBehavior === "minimize" || closeBehavior === "exit"
        ? closeBehavior
        : DEFAULT_GENERAL_CONFIG.closeBehavior,
  }
}

export async function saveGeneralConfig(config: GeneralConfig): Promise<void> {
  const store = await getStore()
  await store.set(GENERAL_CONFIG_KEY, normalizeGeneralConfig(config))
  await store.save()
}

export async function loadGeneralConfig(): Promise<GeneralConfig> {
  const store = await getStore()
  const config = await store.get<Partial<GeneralConfig>>(GENERAL_CONFIG_KEY)
  return normalizeGeneralConfig(config)
}

const SCHEDULED_IMPORT_KEY_PREFIX = "scheduledImportConfig:"

function scheduledImportKey(projectPath: string): string {
  return `${SCHEDULED_IMPORT_KEY_PREFIX}${normalizePath(projectPath)}`
}

const SCHEDULED_IMPORT_GLOBAL_KEY = "scheduledImportConfig"

export async function saveScheduledImportConfig(projectPath: string, config: ScheduledImportConfig): Promise<void> {
  const store = await getStore()
  await store.set(scheduledImportKey(projectPath), config)
  await store.save()
}

export async function loadScheduledImportConfig(projectPath: string): Promise<ScheduledImportConfig | null> {
  const store = await getStore()
  const perProject = await store.get<ScheduledImportConfig>(scheduledImportKey(projectPath))
  if (perProject) return perProject
  // Migrate from legacy global key (pre-0.4.8)
  const legacy = await store.get<ScheduledImportConfig>(SCHEDULED_IMPORT_GLOBAL_KEY)
  if (legacy) {
    await store.set(scheduledImportKey(projectPath), legacy)
    await store.delete(SCHEDULED_IMPORT_GLOBAL_KEY)
    await store.save()
    return legacy
  }
  return null
}

export async function removeFromRecentProjects(
  path: string
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const updated = existing.filter((p) => p.path !== path)
  await store.set(RECENT_PROJECTS_KEY, updated)
  // ALSO clear the last-project pointer if it points at the project
  // we just removed. Without this, App.tsx's startup auto-open
  // (`getLastProject()` → `openProject()` → `saveLastProject()`)
  // re-adds the removed entry back to recents on the next launch,
  // making the delete look like it didn't take. Reported by user
  // as "deleted project comes back after restart."
  const last = await store.get<WikiProject>(LAST_PROJECT_KEY)
  if (last && last.path === path) {
    await store.delete(LAST_PROJECT_KEY)
    await store.save()
    await invoke<string>("api_server_reload_config")
  }
}

const LANGUAGE_KEY = "language"

export async function saveLanguage(lang: string): Promise<void> {
  const store = await getStore()
  await store.set(LANGUAGE_KEY, lang)
}

export async function loadLanguage(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string>(LANGUAGE_KEY)) ?? null
}

const THEME_KEY = "theme"

export async function saveTheme(theme: "light" | "dark" | "system"): Promise<void> {
  const store = await getStore()
  await store.set(THEME_KEY, theme)
}

export async function loadTheme(): Promise<"light" | "dark" | "system" | null> {
  const store = await getStore()
  return (await store.get<"light" | "dark" | "system">(THEME_KEY)) ?? null
}

const OUTPUT_LANGUAGE_KEY = "outputLanguage"
const PROJECT_OUTPUT_LANGUAGE_KEY = "projectOutputLanguages"
const PROJECT_FILE_SYNC_KEY = "projectFileSyncEnabled"
const SOURCE_WATCH_CONFIG_KEY = "sourceWatchConfig"

export async function saveOutputLanguage(lang: OutputLanguage, projectId?: string): Promise<void> {
  const store = await getStore()
  if (projectId) {
    const existing = (await store.get<Record<string, OutputLanguage>>(PROJECT_OUTPUT_LANGUAGE_KEY)) ?? {}
    await store.set(PROJECT_OUTPUT_LANGUAGE_KEY, { ...existing, [projectId]: lang })
  }
  await store.set(OUTPUT_LANGUAGE_KEY, lang)
}

export async function loadOutputLanguage(projectId?: string): Promise<OutputLanguage | null> {
  const store = await getStore()
  if (projectId) {
    const projectLanguages = await store.get<Record<string, OutputLanguage>>(PROJECT_OUTPUT_LANGUAGE_KEY)
    return projectLanguages?.[projectId] ?? null
  }
  return (await store.get<OutputLanguage>(OUTPUT_LANGUAGE_KEY)) ?? null
}

export async function saveProjectFileSyncEnabled(enabled: boolean, projectId?: string): Promise<void> {
  const store = await getStore()
  if (projectId) {
    const existing = (await store.get<Record<string, boolean>>(PROJECT_FILE_SYNC_KEY)) ?? {}
    await store.set(PROJECT_FILE_SYNC_KEY, { ...existing, [projectId]: enabled })
    return
  }
  const existing = (await store.get<Record<string, boolean>>(PROJECT_FILE_SYNC_KEY)) ?? {}
  await store.set(PROJECT_FILE_SYNC_KEY, { ...existing, default: enabled })
}

export async function loadProjectFileSyncEnabled(projectId?: string): Promise<boolean> {
  const store = await getStore()
  const settings = await store.get<Record<string, boolean>>(PROJECT_FILE_SYNC_KEY)
  if (projectId && settings && typeof settings[projectId] === "boolean") {
    return settings[projectId]
  }
  if (settings && typeof settings.default === "boolean") {
    return settings.default
  }
  return true
}

export async function saveSourceWatchConfig(config: SourceWatchConfig, projectId?: string): Promise<void> {
  const store = await getStore()
  const normalized = normalizeSourceWatchConfig(config)
  const existing = (await store.get<Record<string, SourceWatchConfig>>(SOURCE_WATCH_CONFIG_KEY)) ?? {}
  await store.set(SOURCE_WATCH_CONFIG_KEY, {
    ...existing,
    [projectId ?? "default"]: normalized,
  })
  await store.save()
}

export async function loadSourceWatchConfig(projectId?: string): Promise<SourceWatchConfig> {
  const store = await getStore()
  const settings = await store.get<Record<string, SourceWatchConfig>>(SOURCE_WATCH_CONFIG_KEY)
  const config = projectId ? settings?.[projectId] : undefined
  if (config) return normalizeSourceWatchConfig(config)
  if (settings?.default) return normalizeSourceWatchConfig(settings.default)

  const legacyEnabled = await loadProjectFileSyncEnabled(projectId)
  return normalizeSourceWatchConfig({ enabled: legacyEnabled })
}

// ── Update-check persistence ──────────────────────────────────────────────
// Small slice of state the UI-layer update store hydrates from on boot.
// Only fields that should persist across launches: the user's "enable
// auto-check" toggle, the timestamp we last checked (so the 6-hour cache
// survives restarts), and the version the user explicitly dismissed
// (so we don't re-nag on every restart until a newer version is out).

const UPDATE_CHECK_STATE_KEY = "updateCheckState"

export interface PersistedUpdateCheckState {
  enabled: boolean
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

export async function saveUpdateCheckState(
  state: PersistedUpdateCheckState,
): Promise<void> {
  const store = await getStore()
  await store.set(UPDATE_CHECK_STATE_KEY, state)
}

export async function loadUpdateCheckState(): Promise<PersistedUpdateCheckState | null> {
  const store = await getStore()
  return (
    (await store.get<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY)) ?? null
  )
}

const ZOOM_LEVEL_KEY = "zoomLevel"

export async function saveZoomLevel(level: number): Promise<void> {
  const store = await getStore()
  await store.set(ZOOM_LEVEL_KEY, normalizeZoomLevel(level))
  await store.save()
}

export async function loadZoomLevel(): Promise<number> {
  const store = await getStore()
  const level = await store.get<number>(ZOOM_LEVEL_KEY)
  return normalizeZoomLevel(level)
}
