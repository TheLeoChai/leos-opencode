import {
  APICallError,
  InvalidPromptError,
  InvalidResponseDataError,
  LoadAPIKeyError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { AISDK } from "@opencode-ai/core/aisdk"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { InvalidRequestReason, LLM, LLMError, Message } from "@opencode-ai/ai"
import { LLMClient } from "@opencode-ai/ai/route"
import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AISDK.locationLayer)

const model = (packageName: string, settings: Record<string, unknown> = {}) =>
  ModelV2.Info.make({
    ...ModelV2.Info.empty(ProviderV2.ID.make("test-provider"), ModelV2.ID.make("catalog-model")),
    modelID: ModelV2.ID.make("api-model"),
    package: ProviderV2.aisdk(packageName),
    settings,
    limit: { context: 100, output: 20 },
  })

const failingLanguage = (error: unknown): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "test-provider",
  modelId: "api-model",
  supportedUrls: {},
  doGenerate: async () => {
    throw error
  },
  doStream: async () => {
    throw error
  },
})

const streamingLanguage = (...events: LanguageModelV3StreamPart[]): LanguageModelV3 => ({
  ...failingLanguage(new Error("unused")),
  doStream: async () => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        events.forEach((event) => controller.enqueue(event))
        controller.close()
      },
    }),
    request: { body: {} },
  }),
})

const streamFailure = (language: LanguageModelV3) =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {}
    })
    yield* aisdk.hook.language((event) => {
      event.language = language
    })
    const resolved = yield* aisdk.model(model("@ai-sdk/openai"))
    const request = LLM.request({ model: resolved, prompt: "Hello" })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)
    return yield* resolved.route
      .streamPrepared(prepared.body, request, { http: { execute: () => Effect.die("unused") } })
      .pipe(Stream.runDrain, Effect.flip)
  })

it.effect("keys language models by package and flattened overlays", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const loaded: string[] = []
    yield* aisdk.hook.sdk((event) => {
      loaded.push(event.package)
      event.sdk = { languageModel: () => ({ package: event.package }) }
    })

    const first = yield* aisdk.language(model("first", { region: "us-east-1" }))
    const second = yield* aisdk.language(model("second", { region: "us-east-1" }))
    const third = yield* aisdk.language(model("second", { region: "us-west-2" }))

    expect(first).not.toBe(second)
    expect(second).not.toBe(third)
    expect(loaded).toEqual(["first", "second", "second"])
  }),
)

it.effect("projects request settings, headers, and body overlays", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let body: unknown
    yield* aisdk.hook.sdk((event) => {
      body = event.options.body
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const input = model("@ai-sdk/google", {
      apiKey: "secret",
      thinkingConfig: { thinkingBudget: 1024 },
    })
    const resolved = yield* aisdk.model({
      ...input,
      headers: { "x-test": "header" },
      body: { safety_setting: "strict" },
    })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Hello" }),
    )

    expect(prepared.body.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    })
    expect(prepared.body.headers).toEqual({ "x-test": "header" })
    expect(body).toEqual({ safety_setting: "strict" })
  }),
)

it.effect("maps pro reasoning bodies to AI SDK provider options", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let body: unknown
    yield* aisdk.hook.sdk((event) => {
      body = event.options.body
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const resolved = yield* aisdk.model({
      ...model("@ai-sdk/openai"),
      body: { reasoning: { mode: "pro" } },
    })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Hello" }),
    )

    expect(body).toBeUndefined()
    expect(prepared.body.providerOptions).toEqual({
      openai: { forceReasoning: true, reasoningMode: "pro" },
    })
  }),
)

it.effect("maps package-specific AI SDK provider option keys", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const cases = [
      ["@ai-sdk/github-copilot", "copilot", { reasoningEffort: "high" }],
      ["@ai-sdk/amazon-bedrock/mantle", "openai", { reasoningEffort: "high", forceReasoning: true }],
      ["@ai-sdk/openai-compatible", "test-provider", { reasoningEffort: "high" }],
      ["@jerome-benoit/sap-ai-provider-v2", "sap-ai", { reasoningEffort: "high" }],
      ["ai-gateway-provider", "openaiCompatible", { reasoningEffort: "high" }],
    ] as const
    for (const [packageName, key, settings] of cases) {
      const resolved = yield* aisdk.model(model(packageName, { reasoningEffort: "high" }))
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({ model: resolved, prompt: "Hello" }),
      )
      expect(prepared.body.providerOptions).toEqual({ [key]: settings })
    }
  }),
)

it.effect("forces reasoning and projects both Azure AI SDK namespaces", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const openai = yield* aisdk.model(model("@ai-sdk/openai", { reasoningEffort: "high" }))
    const openaiPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: openai, prompt: "Hello" }),
    )
    expect(openaiPrepared.body.providerOptions).toEqual({
      openai: { reasoningEffort: "high", forceReasoning: true },
    })

    const azure = yield* aisdk.model(model("@ai-sdk/azure", { reasoningEffort: "high" }))
    const azurePrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: azure, prompt: "Hello" }),
    )
    expect(azurePrepared.body.providerOptions).toEqual({
      openai: { reasoningEffort: "high", forceReasoning: true },
      azure: { reasoningEffort: "high", forceReasoning: true },
    })
  }),
)

it.effect("routes AI Gateway model options by upstream prefix", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const anthropic = yield* aisdk.model({
      ...model("@ai-sdk/gateway", {
        gateway: { order: ["anthropic"] },
        thinking: { type: "adaptive" },
      }),
      modelID: ModelV2.ID.make("anthropic/claude-sonnet-5"),
    })
    const anthropicPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: anthropic, prompt: "Hello" }),
    )
    expect(anthropicPrepared.body.providerOptions).toEqual({
      gateway: { order: ["anthropic"] },
      anthropic: { thinking: { type: "adaptive" } },
    })

    const bedrock = yield* aisdk.model({
      ...model("@ai-sdk/gateway", { reasoningConfig: { type: "enabled" } }),
      modelID: ModelV2.ID.make("amazon/nova-2-lite"),
    })
    const bedrockPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: bedrock, prompt: "Hello" }),
    )
    expect(bedrockPrepared.body.providerOptions).toEqual({
      bedrock: { reasoningConfig: { type: "enabled" } },
    })

    const fallback = yield* aisdk.model({
      ...model("@ai-sdk/gateway", { reasoningEffort: "high" }),
      modelID: ModelV2.ID.make("deepseek/deepseek-v4"),
    })
    const fallbackPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: fallback, prompt: "Hello" }),
    )
    expect(fallbackPrepared.body.providerOptions).toEqual({
      deepseek: { reasoningEffort: "high" },
    })
  }),
)

it.effect("projects replay metadata onto AI SDK prompt parts", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    expect(resolved.route.providerMetadataKey).toBe("anthropic")
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: resolved,
        messages: [
          Message.assistant([
            { type: "reasoning", text: "Think", providerMetadata: { anthropic: { signature: "signed" } } },
            {
              type: "tool-call",
              id: "hosted",
              name: "web_search",
              input: { query: "Effect" },
              providerExecuted: true,
              providerMetadata: { anthropic: { blockType: "server_tool_use" } },
            },
          ]),
        ],
      }),
    )

    expect(prepared.body.prompt).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Think",
            providerOptions: { anthropic: { signature: "signed" } },
          },
          {
            type: "tool-call",
            toolCallId: "hosted",
            toolName: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
            providerOptions: { anthropic: { blockType: "server_tool_use" } },
          },
        ],
      },
    ])
  }),
)

it.effect("classifies AI SDK API failures", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Bad Request",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: '{"error":{"code":"insufficient_quota","detail":"quota-body-secret"}}',
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "QuotaExceeded" } })
    expect("http" in error.reason ? error.reason.http : undefined).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain("quota-body-secret")
  }),
)

it.effect("keeps retryable quota responses terminal", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Quota exceeded",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 429,
          responseBody: '{"error":{"code":"insufficient_quota"}}',
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "QuotaExceeded" } })
  }),
)

it.effect("uses response bodies as transient classification evidence", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Bad Request",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: "Input is too long for requested model overflow-body-secret",
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "InvalidRequest", classification: "context-overflow" } })
    expect("http" in error.reason ? error.reason.http : undefined).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain("overflow-body-secret")
  }),
)

it.effect("honors retryable AI SDK request timeouts", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "HTTP 408",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 408,
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "ProviderInternal", status: 408 } })
  }),
)

it.effect("honors retryable AI SDK conflicts", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "HTTP 409",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 409,
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "ProviderInternal", status: 409 } })
  }),
)

it.effect("keeps semantic invalid requests terminal on retryable statuses", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Conflict",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 409,
          responseBody: '{"error":{"code":"request_too_large"}}',
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "InvalidRequest" } })
  }),
)

it.effect("retries unknown coded conflicts", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Conflict",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 409,
          responseBody: '{"error":{"code":"conflict"}}',
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "ProviderInternal", status: 409 } })
  }),
)

it.effect("preserves AI SDK retry delays without HTTP diagnostics", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Too Many Requests",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "Retry-After-Ms": "250" },
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "RateLimit", retryAfterMs: 250 } })
    expect("http" in error.reason ? error.reason.http : undefined).toBeUndefined()
  }),
)

it.effect("classifies statusless retryable API failures as transport failures", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Cannot connect to API",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          isRetryable: true,
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "Transport" } })
  }),
)

it.effect("classifies AI SDK timeouts", () =>
  Effect.gen(function* () {
    const timeout = yield* streamFailure(failingLanguage(new DOMException("timed out", "TimeoutError")))

    expect(timeout).toMatchObject({ reason: { _tag: "Transport", kind: "Timeout" } })
  }),
)

it.effect("classifies AI SDK connection failures", () =>
  Effect.gen(function* () {
    const reset = yield* streamFailure(
      failingLanguage(Object.assign(new Error("connection reset"), { code: "ECONNRESET" })),
    )

    expect(reset).toMatchObject({ reason: { _tag: "Transport", kind: "ECONNRESET" } })
  }),
)

it.effect("classifies Bun connection failures", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(Object.assign(new Error("connection refused"), { code: "ConnectionRefused" })),
    )

    expect(error).toMatchObject({ reason: { _tag: "Transport", kind: "CONNECTIONREFUSED" } })
  }),
)

it.effect("classifies structured AI SDK stream errors", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      streamingLanguage({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    )

    expect(error).toMatchObject({ reason: { _tag: "ProviderInternal", message: "Overloaded" } })
  }),
)

it.effect("classifies structured stream messages without codes", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      streamingLanguage({ type: "error", error: { message: "Rate limit exceeded" } }),
    )

    expect(error).toMatchObject({ reason: { _tag: "RateLimit" } })
  }),
)

it.effect("classifies nested OpenAI Responses stream errors", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      streamingLanguage({
        type: "error",
        error: {
          type: "response.failed",
          response: { error: { code: "server_error", message: "Provider failed" } },
        },
      }),
    )

    expect(error).toMatchObject({ reason: { _tag: "ProviderInternal", message: "Provider failed" } })
  }),
)

it.effect("classifies numeric string stream statuses", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      streamingLanguage({ type: "error", error: { code: "503", message: "Unavailable" } }),
    )

    expect(error).toMatchObject({ reason: { _tag: "ProviderInternal", status: 503 } })
  }),
)

it.effect("classifies missing AI SDK API keys", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(new LoadAPIKeyError({ message: "API key is missing" })),
    )

    expect(error).toMatchObject({ reason: { _tag: "Authentication", kind: "missing" } })
  }),
)

it.effect("classifies invalid AI SDK prompts", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(new InvalidPromptError({ prompt: [], message: "unsupported prompt" })),
    )

    expect(error).toMatchObject({ reason: { _tag: "InvalidRequest" } })
  }),
)

it.effect("preserves existing LLM errors", () =>
  Effect.gen(function* () {
    const original = new LLMError({
      module: "test",
      method: "run",
      reason: new InvalidRequestReason({ message: "invalid" }),
    })
    const error = yield* streamFailure(failingLanguage(original))

    expect(error).toBe(original)
  }),
)

it.effect("classifies malformed AI SDK response causes", () =>
  Effect.gen(function* () {
    const error = yield* streamFailure(
      failingLanguage(
        new APICallError({
          message: "Failed to process response",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 200,
          cause: new InvalidResponseDataError({ data: { invalid: true } }),
        }),
      ),
    )

    expect(error).toMatchObject({ reason: { _tag: "InvalidProviderOutput" } })
  }),
)
