import { AccountPool } from "./accounts.js"
import { runOAuthFlow, verifyAccount } from "./oauth.js"
import {
  canAccountHandlePath,
  createOpenAIRequestContext,
  finalizeOpenAIResponse,
  getRequestUrl,
  isManagedOpenAIRequest,
  prepareOpenAIRequest,
} from "./request.js"
import { loadData, addAccount, saveData } from "./storage.js"
import type { Account, ApiKeyAccount } from "./types.js"

export type { Account, OAuthAccount, ApiKeyAccount, PluginSettings } from "./types.js"
export { AccountPool } from "./accounts.js"

type PluginInput = {
  client: Record<string, any>
  serverUrl: URL
  directory: string
  [k: string]: unknown
}

type AuthDetails =
  | { type: "oauth"; refresh: string; access?: string; expires?: number; accountId?: string }
  | { type: "api_key"; key: string }
  | { type: string; [k: string]: unknown }

type GetAuth = () => Promise<AuthDetails>

type ProviderModel = {
  cost?: { input: number; output: number }
  [k: string]: unknown
}

type Provider = {
  models?: Record<string, ProviderModel>
}

type LoaderResult = {
  apiKey: string
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

type SelectOption = { label: string; value: string; hint?: string }
type Prompt =
  | { type: "text"; key: string; message: string; placeholder?: string }
  | { type: "select"; key: string; message: string; options: SelectOption[] }

type AuthOAuthResult = {
  url: string
  instructions: string
} & (
  | { method: "auto"; callback(): Promise<AuthCallbackResult> }
  | { method: "code"; callback(code: string): Promise<AuthCallbackResult> }
)

type AuthCallbackResult =
  | {
      type: "success"
      refresh: string
      access: string
      expires: number
      accountId?: string
      provider?: string
    }
  | { type: "success"; key: string; provider?: string }
  | { type: "failed" }

type AuthMethod =
  | {
      type: "oauth"
      label: string
      prompts?: Prompt[]
      authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
    }
  | {
      type: "api"
      label: string
      prompts?: Prompt[]
      authorize?(inputs?: Record<string, string>): Promise<AuthCallbackResult>
    }

type AuthHook = {
  provider: string
  loader(getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>>
  methods: AuthMethod[]
}

type Hooks = {
  event?: (input: { event: any }) => Promise<void>
  auth?: AuthHook
  tool?: Record<string, any>
}

const DEBUG = process.env.CHATGPT_ROTATION_DEBUG === "1"

function debugLog(message: string): void {
  if (DEBUG) console.log(message)
}

function getAccountStatusLabel(account: Account, pool: AccountPool): string {
  const status = pool.getStatus().find((candidate) => candidate.label === account.label)
  if (!status) return "unknown"

  const parts: string[] = []
  if (!status.available) parts.push("rate-limited")
  else parts.push("active")
  if (status.tokenExpired) parts.push("token expired")
  return parts.join(", ")
}

function formatTimeSince(account: Account): string {
  if (account.type !== "oauth") return ""
  const ago = Date.now() - account.expiresAt
  if (ago < 0) return "token valid"

  const mins = Math.floor(ago / 60_000)
  if (mins < 60) return `expired ${mins}m ago`

  const hours = Math.floor(mins / 60)
  if (hours < 24) return `expired ${hours}h ago`
  return `expired ${Math.floor(hours / 24)}d ago`
}

function buildActionPrompts(pool: AccountPool): Prompt[] {
  const data = loadData()
  const options: SelectOption[] = []
  const verifyTargets: SelectOption[] = []

  options.push({ label: "Add account", value: "add_account", hint: "OAuth with OpenAI" })
  options.push({ label: "Check status", value: "check_status" })
  options.push({ label: "Verify one account", value: "verify_one" })
  options.push({ label: "Verify all accounts", value: "verify_all" })

  if (data.accounts.length > 0) {
    for (let i = 0; i < data.accounts.length; i++) {
      const account = data.accounts[i]
      const statusLabel = getAccountStatusLabel(account, pool)
      const timeInfo = formatTimeSince(account)
      const hint = [statusLabel, timeInfo].filter(Boolean).join(" | ")

      options.push({
        label: `${i + 1}. ${account.label}`,
        value: `account:${i}`,
        hint: `[${hint}]`,
      })
      verifyTargets.push({
        label: `${i + 1}. ${account.label}`,
        value: String(i),
        hint: `[${hint}]`,
      })
    }
  }

  if (data.accounts.length > 0) {
    options.push({ label: "Delete all accounts", value: "delete_all", hint: "irreversible" })
  }

  const prompts: Prompt[] = [
    { type: "select", key: "action", message: "Select an action or account", options },
  ]

  if (verifyTargets.length > 0) {
    prompts.push({
      type: "select",
      key: "verify_target",
      message: "Account to verify (used by 'Verify one account')",
      options: verifyTargets,
    })
  }

  return prompts
}

function toAuthCallbackSuccess(account: Account): AuthCallbackResult {
  if (account.type === "oauth") {
    return {
      type: "success",
      access: account.accessToken,
      refresh: account.refreshToken,
      expires: account.expiresAt,
      accountId: account.accountId,
    }
  }

  return { type: "success", key: account.apiKey }
}

function infoResult(
  message: string,
  fallbackAccount: Account | null = loadData().accounts[0] ?? null,
): AuthOAuthResult {
  return {
    url: "data:text/html,<html><body style='font-family:system-ui;text-align:center;padding:60px'><p>Done. You can close this tab.</p></body></html>",
    instructions: message,
    method: "auto" as const,
    async callback(): Promise<AuthCallbackResult> {
      if (fallbackAccount) {
        return toAuthCallbackSuccess(fallbackAccount)
      }
      return { type: "failed" }
    },
  }
}

export const ChatGPTRotationPlugin = async (input: PluginInput): Promise<Hooks> => {
  const data = loadData()
  const pool = new AccountPool(data.accounts, data.settings.strategy)

  function showToast(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
  ): void {
    const body = { title: "ChatGPT Rotation", message, variant, duration: 3000 }

    try {
      const client = input.client as any
      if (typeof client.showToast === "function") {
        client.showToast({ body }).catch(() => {})
        return
      }
      if (typeof client.tui?.showToast === "function") {
        client.tui.showToast({ body }).catch(() => {})
        return
      }
    } catch {}

    const paths = ["/tui/show-toast", "/api/tui/show-toast"]
    for (const path of paths) {
      try {
        const url = new URL(path, input.serverUrl)
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => {})
      } catch {}
    }
  }

  function reloadPool(): void {
    const fresh = loadData()
    pool.updateAccounts(fresh.accounts)
  }

  function parseRetryAfter(headers: Headers): number | undefined {
    const value = headers.get("retry-after")
    if (!value) return undefined
    const parsed = parseInt(value, 10)
    return isNaN(parsed) ? undefined : parsed
  }

  function exhaustedAccountsResponse(): Response {
    const waitMs = pool.getMinWaitMs()
    const waitSec = Math.ceil(waitMs / 1000)
    const message =
      waitSec > 0
        ? `All accounts are rate-limited. Retry in ${waitSec}s.`
        : "All accounts are unavailable or have invalid tokens."

    return Response.json(
      {
        error: {
          message,
          type: "rate_limit_error",
          code: "all_accounts_exhausted",
        },
      },
      {
        status: 429,
        headers: waitSec > 0 ? { "Retry-After": String(waitSec) } : undefined,
      },
    )
  }

  function unsupportedPathResponse(pathname: string): Response {
    return Response.json(
      {
        error: {
          message: `Configured ChatGPT OAuth accounts only support /v1/responses. Received ${pathname}. Add an API key account to handle this path.`,
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    )
  }

  const client = input.client as any
  debugLog(`[chatgpt-rotation] serverUrl: ${input.serverUrl}`)
  debugLog(`[chatgpt-rotation] client keys: ${Object.keys(client).join(", ")}`)
  if (client.tui) debugLog(`[chatgpt-rotation] client.tui keys: ${Object.keys(client.tui).join(", ")}`)

  const authHook: AuthHook = {
    provider: "openai",
    async loader(_getAuth, provider): Promise<LoaderResult> {
      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 }
          }
        }
      }

      return {
        apiKey: "",
        async fetch(requestInfo, init): Promise<Response> {
          const url = getRequestUrl(requestInfo, init)
          if (!isManagedOpenAIRequest(url)) {
            return fetch(requestInfo, init)
          }

          const context = await createOpenAIRequestContext(requestInfo, init)

          reloadPool()
          const { accounts, settings } = loadData()
          if (pool.size === 0) {
            throw new Error("No ChatGPT rotation accounts configured. Run `opencode auth login`.")
          }

          if (!accounts.some((account) => canAccountHandlePath(account, context.url.pathname))) {
            return unsupportedPathResponse(context.url.pathname)
          }

          let lastResponse: Response | null = null

          for (let attempt = 0; attempt < settings.maxRetries; attempt++) {
            const active = await pool.getActiveAccount((account) =>
              canAccountHandlePath(account, context.url.pathname),
            )
            if (!active) {
              return exhaustedAccountsResponse()
            }

            const prepared = prepareOpenAIRequest(
              context,
              active.account,
              active.token,
              settings.targetBaseUrl,
            )

            if (!prepared) {
              return unsupportedPathResponse(context.url.pathname)
            }

            if (attempt === 0) {
              showToast(`Using ${active.label}`, "info")
            }

            let upstream: Response
            try {
              upstream = await fetch(prepared.upstreamUrl, prepared.init)
            } catch (error) {
              console.error("[chatgpt-rotation] Upstream request failed", error)
              return Response.json(
                { error: { message: "Upstream request failed", type: "proxy_error" } },
                { status: 502 },
              )
            }

            const response = finalizeOpenAIResponse(upstream, prepared.isStreamingRequest)
            if (upstream.status === 429) {
              pool.onRateLimit(active.label, parseRetryAfter(upstream.headers))
              console.warn(
                `[chatgpt-rotation] Account "${active.label}" rate-limited. Attempt ${attempt + 1}/${settings.maxRetries}.`,
              )
              lastResponse = response
              await Bun.sleep(300)
              continue
            }

            if (upstream.ok) {
              pool.onSuccess(active.label)
            }

            return response
          }

          return lastResponse ?? exhaustedAccountsResponse()
        },
      }
    },
    methods: [
      {
        type: "oauth",
        label: "ChatGPT Plus/Pro (multi-account rotation)",
        get prompts(): Prompt[] {
          return buildActionPrompts(pool)
        },
        async authorize(inputs): Promise<AuthOAuthResult> {
          const action = inputs?.action ?? "add_account"

          if (action === "add_account") {
            const flow = await runOAuthFlow()
            return {
              url: flow.url,
              instructions: "Complete authorization in your browser.",
              method: "auto" as const,
              async callback(): Promise<AuthCallbackResult> {
                const account = await flow.waitForAccount()
                if (!account) return { type: "failed" }

                addAccount(account)
                reloadPool()
                console.log(
                  `[chatgpt-rotation] Added account "${account.label}". Total: ${pool.size}.`,
                )

                return {
                  type: "success",
                  access: account.accessToken,
                  refresh: account.refreshToken,
                  expires: account.expiresAt,
                  accountId: account.accountId,
                }
              },
            }
          }

          if (action === "check_status") {
            const statuses = pool.getStatus()
            const lines =
              statuses.length === 0
                ? ["No accounts configured."]
                : statuses.map(
                    (status, index) =>
                      `  ${index + 1}. ${status.label} (${status.type}) — ${status.available ? "active" : "rate-limited"}` +
                      (status.tokenExpired ? " [token expired]" : "") +
                      (status.unlocksAt ? ` [unlocks ${status.unlocksAt}]` : ""),
                  )
            return infoResult(`Account Status (${statuses.length}):\n${lines.join("\n")}`)
          }

          if (action === "verify_one") {
            const idx = parseInt(inputs?.verify_target ?? "0", 10)
            const accounts = loadData().accounts
            if (idx < 0 || idx >= accounts.length) {
              return infoResult("Invalid account selection.")
            }

            const account = accounts[idx]
            const result = await verifyAccount(account)
            const status = result.valid ? "Valid" : `Invalid — ${result.error}`
            return infoResult(`${account.label}: ${status}`)
          }

          if (action === "verify_all") {
            const accounts = loadData().accounts
            if (accounts.length === 0) return infoResult("No accounts to verify.")

            const lines: string[] = []
            for (const account of accounts) {
              const result = await verifyAccount(account)
              lines.push(
                `  ${account.label}: ${result.valid ? "Valid" : `Invalid — ${result.error}`}`,
              )
            }
            return infoResult(`Verification Results:\n${lines.join("\n")}`)
          }

          if (action.startsWith("account:")) {
            const idx = parseInt(action.split(":")[1] ?? "-1", 10)
            const accounts = loadData().accounts
            if (idx < 0 || idx >= accounts.length) {
              return infoResult("Account not found.")
            }

            const account = accounts[idx]
            const verification = await verifyAccount(account)
            const info = [
              `Account: ${account.label}`,
              `Type: ${account.type}`,
              account.type === "oauth" ? `Account ID: ${account.accountId ?? "unknown"}` : "",
              account.type === "oauth" ? `Token: ${formatTimeSince(account)}` : "",
              `Status: ${verification.valid ? "Valid" : `Invalid — ${verification.error}`}`,
            ]
              .filter(Boolean)
              .join("\n  ")
            return infoResult(`  ${info}`)
          }

          if (action === "delete_all") {
            const stored = loadData()
            const fallbackAccount = stored.accounts[0] ?? null
            stored.accounts = []
            saveData(stored)
            reloadPool()
            console.log("[chatgpt-rotation] All accounts deleted.")
            return infoResult("All accounts have been deleted.", fallbackAccount)
          }

          return infoResult("Unknown action.")
        },
      },
      {
        type: "api",
        label: "Manually enter API Key",
        prompts: [
          { type: "text", key: "api_key", message: "OpenAI API key", placeholder: "sk-..." },
          {
            type: "text",
            key: "label",
            message: "Label for this key (optional)",
            placeholder: "my-work-key",
          },
        ],
        async authorize(inputs): Promise<AuthCallbackResult> {
          const key = inputs?.api_key
          if (!key) return { type: "failed" }

          const account: ApiKeyAccount = {
            type: "api_key",
            label: inputs?.label || `key-${Date.now()}`,
            apiKey: key,
          }
          addAccount(account)
          reloadPool()
          console.log(
            `[chatgpt-rotation] Added API key "${account.label}". Total: ${pool.size}.`,
          )
          return { type: "success", key }
        },
      },
    ],
  }

  return {
    auth: authHook,
  }
}
