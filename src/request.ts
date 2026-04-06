import type { Account } from "./types.js"

const CODEX_RESPONSE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const CODEX_ORIGINATOR = "opencode"
const CODEX_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id"
const CODEX_DEFAULT_INSTRUCTIONS =
  "You are OpenCode, the best coding agent on the planet.\n\nYou are an interactive CLI tool that helps users with software engineering tasks."

export interface OpenAIRequestContext {
  request: Request
  url: URL
  method: string
  headers: Headers
  bodyText: string | null
  bodyJson: unknown
  signal?: AbortSignal
}

export interface PreparedUpstreamRequest {
  upstreamUrl: string
  init: RequestInit
  isStreamingRequest: boolean
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function buildBaseHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  next.delete("authorization")
  next.delete("connection")
  next.delete("content-length")
  next.delete("host")
  return next
}

function resolveUpstreamUrl(baseUrl: string, requestUrl: URL): string {
  const upstream = new URL(baseUrl)
  upstream.pathname = requestUrl.pathname
  upstream.search = requestUrl.search
  return upstream.toString()
}

function transformCodexBody(bodyText: string | null, bodyJson: unknown): string | undefined {
  if (bodyText === null) return undefined
  if (!isObjectRecord(bodyJson)) return bodyText

  const {
    max_output_tokens: _maxOutputTokens,
    max_completion_tokens: _maxCompletionTokens,
    ...nextBody
  } = bodyJson

  const instructions = trimString(nextBody.instructions) || CODEX_DEFAULT_INSTRUCTIONS

  return JSON.stringify({
    ...nextBody,
    instructions,
  })
}

export function isManagedOpenAIRequest(url: URL): boolean {
  return url.hostname === "api.openai.com" || url.hostname === "chatgpt.com"
}

export function getRequestUrl(input: RequestInfo | URL, init?: RequestInit): URL {
  return new URL(new Request(input, init).url)
}

export function canAccountHandlePath(account: Account, path: string): boolean {
  if (account.type === "api_key") return true
  return path === "/v1/responses"
}

export async function createOpenAIRequestContext(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<OpenAIRequestContext> {
  const request = new Request(input, init)
  const method = request.method.toUpperCase()
  const bodyText = method === "GET" || method === "HEAD" ? null : await request.text()

  let bodyJson: unknown = null
  if (bodyText && (request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      bodyJson = JSON.parse(bodyText) as unknown
    } catch {
      bodyJson = null
    }
  }

  return {
    request,
    url: new URL(request.url),
    method,
    headers: new Headers(request.headers),
    bodyText,
    bodyJson,
    signal: request.signal,
  }
}

export function prepareOpenAIRequest(
  context: OpenAIRequestContext,
  account: Account,
  token: string,
  targetBaseUrl: string,
): PreparedUpstreamRequest | null {
  const headers = buildBaseHeaders(context.headers)
  const isStreamingRequest = isObjectRecord(context.bodyJson) && context.bodyJson.stream === true

  headers.set("authorization", `Bearer ${token}`)

  if (account.type === "oauth") {
    if (context.url.pathname !== "/v1/responses") {
      return null
    }

    if (!headers.get("originator")) {
      headers.set("originator", CODEX_ORIGINATOR)
    }
    if (account.accountId) {
      headers.set(CODEX_ACCOUNT_ID_HEADER, account.accountId)
    }

    return {
      upstreamUrl: CODEX_RESPONSE_ENDPOINT,
      init: {
        method: context.method,
        headers,
        body: transformCodexBody(context.bodyText, context.bodyJson),
        signal: context.signal,
      },
      isStreamingRequest,
    }
  }

  return {
    upstreamUrl: resolveUpstreamUrl(targetBaseUrl, context.url),
    init: {
      method: context.method,
      headers,
      body: context.bodyText === null ? undefined : context.bodyText,
      signal: context.signal,
    },
    isStreamingRequest,
  }
}

export function finalizeOpenAIResponse(
  response: Response,
  isStreamingRequest: boolean,
): Response {
  if (!response.body || !isStreamingRequest) {
    return response
  }

  const headers = new Headers(response.headers)
  if (headers.get("content-type")) {
    return response
  }

  headers.set("content-type", "text/event-stream; charset=utf-8")
  headers.delete("content-length")

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
