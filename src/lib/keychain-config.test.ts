import { describe, expect, it } from "vitest"
import { plaintextSecretPaths, redactConfigSecrets, restoreConfigSecrets } from "./keychain-config"

describe("keychain-config", () => {
  it("moves every supported credential out of persisted configuration", () => {
    const { config, secrets } = redactConfigSecrets({
      llmConfig: { apiKey: "llm-secret", model: "gpt-test" },
      providerConfigs: { openai: { apiKey: "preset-secret", model: "gpt-test" } },
      searchApiConfig: {
        apiKey: "search-secret",
        providerConfigs: { tavily: { apiKey: "tavily-secret" } },
      },
      embeddingConfig: { apiKey: "embedding-secret", extraHeaders: { "X-Api-Key": "header-secret" } },
      multimodalConfig: { apiKey: "vision-secret" },
      mineruConfig: { token: "mineru-secret" },
      proxyConfig: { url: "https://user:proxy-secret@example.test" },
      apiConfig: { token: "api-secret", enabled: true },
    })

    expect(JSON.stringify(config)).not.toContain("secret")
    expect(secrets).toEqual({
      "llmConfig.apiKey": "llm-secret",
      "providerConfigs.openai.apiKey": "preset-secret",
      "searchApiConfig.apiKey": "search-secret",
      "searchApiConfig.providerConfigs.tavily.apiKey": "tavily-secret",
      "embeddingConfig.apiKey": "embedding-secret",
      "embeddingConfig.extraHeaders": '{"X-Api-Key":"header-secret"}',
      "multimodalConfig.apiKey": "vision-secret",
      "mineruConfig.token": "mineru-secret",
      "proxyConfig.url": "https://user:proxy-secret@example.test",
      "apiConfig.token": "api-secret",
    })
  })

  it("restores runtime credentials without changing non-secret settings", () => {
    const config = {
      llmConfig: { apiKey: "", model: "gpt-test" },
      apiConfig: { token: "", enabled: true },
    }

    expect(restoreConfigSecrets(config, {
      "llmConfig.apiKey": "llm-secret",
      "apiConfig.token": "api-secret",
    })).toEqual({
      llmConfig: { apiKey: "llm-secret", model: "gpt-test" },
      apiConfig: { token: "api-secret", enabled: true },
    })
  })

  it("emits an empty value when a user clears a stored credential", () => {
    const { secrets } = redactConfigSecrets({
      apiConfig: { token: "", enabled: true },
    })

    expect(secrets).toEqual({ "apiConfig.token": "" })
  })

  it("does not revoke redacted values while loading persisted configuration", () => {
    const { secrets } = redactConfigSecrets(
      { apiConfig: { token: "", enabled: true } },
      false,
    )

    expect(secrets).toEqual({})
  })

  it("reports plaintext paths without returning their values", () => {
    expect(plaintextSecretPaths({
      llmConfig: { apiKey: "stored-value" },
      providerConfigs: { custom: { apiKey: "stored-value" } },
      embeddingConfig: { extraHeaders: { Authorization: "stored-value" } },
    })).toEqual([
      "llmConfig.apiKey",
      "providerConfigs.custom.apiKey",
      "embeddingConfig.extraHeaders",
    ])
  })
})

describe("upstream custom-header credentials", () => {
  it("redacts and restores global and per-provider headers without mutating input", () => {
    const input = {
      llmConfig: { model: "fixture", customHeaders: { Authorization: "fixture" } },
      providerConfigs: { "custom-example": { apiKey: "fixture", customHeaders: { "X-Credential": "fixture" } } },
    }
    const { config, secrets } = redactConfigSecrets(input)
    expect(config).toEqual({ llmConfig: { model: "fixture", customHeaders: {} }, providerConfigs: { "custom-example": { apiKey: "", customHeaders: {} } } })
    expect(restoreConfigSecrets(config, secrets)).toEqual(input)
    expect(plaintextSecretPaths(input)).toContain("llmConfig.customHeaders")
    expect(plaintextSecretPaths(input)).toContain("providerConfigs.custom-example.customHeaders")
    expect(plaintextSecretPaths(config)).toEqual([])
    expect(input.llmConfig.customHeaders.Authorization).toBe("fixture")
  })

  it("preserves redacted headers on load and represents explicit user clearing", () => {
    const input = { llmConfig: { customHeaders: {} } }
    expect(redactConfigSecrets(input, false).secrets).toEqual({})
    expect(redactConfigSecrets(input).secrets).toEqual({ "llmConfig.customHeaders": "{}" })
  })
})
