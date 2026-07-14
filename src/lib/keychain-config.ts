export type StoredConfig = Record<string, unknown>

export interface RedactedConfig {
  config: StoredConfig
  secrets: Record<string, string>
}

export function plaintextSecretPaths(input: StoredConfig): string[] {
  return Object.keys(redactConfigSecrets(input, false).secrets)
}

const STATIC_SECRET_PATHS = [
  "llmConfig.apiKey",
  "searchApiConfig.apiKey",
  "embeddingConfig.apiKey",
  "multimodalConfig.apiKey",
  "mineruConfig.token",
  "proxyConfig.url",
  "apiConfig.token",
] as const

function cloneConfig<T extends StoredConfig>(config: T): T {
  return JSON.parse(JSON.stringify(config)) as T
}

function getAtPath(config: StoredConfig, path: string[]): unknown {
  let current: unknown = config
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as StoredConfig)[part]
  }
  return current
}

function setAtPath(config: StoredConfig, path: string[], value: unknown): void {
  let current = config
  for (const part of path.slice(0, -1)) {
    const next = current[part]
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {}
    current = current[part] as StoredConfig
  }
  current[path[path.length - 1]] = value
}

function moveString(
  config: StoredConfig,
  path: string,
  secrets: Record<string, string>,
  includeEmpty: boolean,
): void {
  const parts = path.split(".")
  const value = getAtPath(config, parts)
  if (typeof value === "string" && (includeEmpty || value.length > 0)) {
    secrets[path] = value
    setAtPath(config, parts, "")
  }
}

function moveProviderKeys(
  config: StoredConfig,
  path: string,
  secrets: Record<string, string>,
  includeEmpty: boolean,
): void {
  const providers = getAtPath(config, path.split("."))
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return
  for (const [provider, value] of Object.entries(providers as StoredConfig)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    moveString(config, `${path}.${provider}.apiKey`, secrets, includeEmpty)
  }
}

export function redactConfigSecrets(input: StoredConfig, includeEmpty: boolean = true): RedactedConfig {
  const config = cloneConfig(input)
  const secrets: Record<string, string> = {}

  for (const path of STATIC_SECRET_PATHS) moveString(config, path, secrets, includeEmpty)
  moveProviderKeys(config, "providerConfigs", secrets, includeEmpty)
  moveProviderKeys(config, "searchApiConfig.providerConfigs", secrets, includeEmpty)

  const headers = getAtPath(config, ["embeddingConfig", "extraHeaders"])
  if (headers && typeof headers === "object" && !Array.isArray(headers) && (includeEmpty || Object.keys(headers).length > 0)) {
    secrets["embeddingConfig.extraHeaders"] = JSON.stringify(headers)
    setAtPath(config, ["embeddingConfig", "extraHeaders"], {})
  }

  return { config, secrets }
}

export function restoreConfigSecrets(input: StoredConfig, secrets: Record<string, string>): StoredConfig {
  const config = cloneConfig(input)
  for (const [path, value] of Object.entries(secrets)) {
    if (path === "embeddingConfig.extraHeaders") {
      try {
        setAtPath(config, path.split("."), JSON.parse(value))
      } catch {
        setAtPath(config, path.split("."), {})
      }
      continue
    }
    setAtPath(config, path.split("."), value)
  }
  return config
}
