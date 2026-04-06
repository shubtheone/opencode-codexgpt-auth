import { AccountPool } from "./accounts.js"
import { startProxyServer } from "./proxy.js"
import { runOAuthFlow, verifyAccount } from "./oauth.js"
import { loadData, addAccount, removeAccount, saveData } from "./storage.js"
import type { Account, ApiKeyAccount } from "./types.js"

export type { Account, OAuthAccount, ApiKeyAccount, PluginSettings } from "./types.js"
export { AccountPool } from "./accounts.js"

// ─── Plugin types (loose, avoids hard @opencode-ai/plugin dep) ───────────────

type PluginInput = {
  client: {
    tui: {
      showToast(options: {
        body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }
      }): Promise<unknown>
    }
    [k: string]: unknown
  }
  directory: string
  [k: string]: unknown
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
  | { type: "success"; refresh: string; access: string; expires: number; accountId?: string; provider?: string }
  | { type: "success"; key: string; provider?: string }
  | { type: "failed" }

type AuthHook = {
  provider: string
  methods: Array<
    | { type: "oauth"; label: string; prompts?: Prompt[]; authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult> }
    | { type: "api"; label: string; prompts?: Prompt[]; authorize?(inputs?: Record<string, string>): Promise<AuthCallbackResult> }
  >
}

type Hooks = {
  config?: (cfg: any) => Promise<void>
  event?: (input: { event: any }) => Promise<void>
  auth?: AuthHook
  tool?: Record<string, any>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAccountStatusLabel(account: Account, pool: AccountPool): string {
  const status = pool.getStatus().find((s) => s.label === account.label)
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

  options.push({ label: "Add account", value: "add_account", hint: "OAuth with OpenAI" })
  options.push({ label: "Check status", value: "check_status" })
  options.push({ label: "Verify one account", value: "verify_one" })
  options.push({ label: "Verify all accounts", value: "verify_all" })

  if (data.accounts.length > 0) {
    for (let i = 0; i < data.accounts.length; i++) {
      const acct = data.accounts[i]
      const statusLabel = getAccountStatusLabel(acct, pool)
      const timeInfo = formatTimeSince(acct)
      const hint = [statusLabel, timeInfo].filter(Boolean).join(" | ")
      options.push({
        label: `${i + 1}. ${acct.label}`,
        value: `account:${i}`,
        hint: `[${hint}]`,
      })
    }
  }

  if (data.accounts.length > 0) {
    options.push({ label: "Delete all accounts", value: "delete_all", hint: "irreversible" })
  }

  return [{ type: "select", key: "action", message: "Select an action or account", options }]
}

/**
 * For non-auth actions (status, verify, etc.), return a "success" result
 * using the first account's real token data. This avoids the
 * "Failed to authorize" message in the OpenCode UI.
 */
function infoResult(message: string): AuthOAuthResult {
  const data = loadData()
  const firstOAuth = data.accounts.find((a) => a.type === "oauth")

  return {
    url: "data:text/html,<html><body style='font-family:system-ui;text-align:center;padding:60px'><p>Done. You can close this tab.</p></body></html>",
    instructions: message,
    method: "auto" as const,
    async callback(): Promise<AuthCallbackResult> {
      // Return success with existing token data so OpenCode doesn't show "Failed to authorize"
      if (firstOAuth && firstOAuth.type === "oauth") {
        return {
          type: "success",
          access: firstOAuth.accessToken,
          refresh: firstOAuth.refreshToken,
          expires: firstOAuth.expiresAt,
          accountId: firstOAuth.accountId,
        }
      }
      const firstKey = data.accounts.find((a) => a.type === "api_key")
      if (firstKey && firstKey.type === "api_key") {
        return { type: "success", key: firstKey.apiKey }
      }
      return { type: "failed" }
    },
  }
}

// ─── Plugin entry ────────────────────────────────────────────────────────────

export const ChatGPTRotationPlugin = async (input: PluginInput): Promise<Hooks> => {
  const data = loadData()
  const { settings } = data

  const pool = new AccountPool(data.accounts, settings.strategy)
  const port = settings.port

  let proxyStarted = false

  // Show a toast notification in the OpenCode TUI
  function showToast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      input.client.tui.showToast({
        body: { title: "ChatGPT Rotation", message, variant, duration: 3000 },
      })
    } catch {
      // Silently fail if toast API isn't available
    }
  }

  function ensureProxy(): void {
    if (proxyStarted || pool.size === 0) return
    startProxyServer({
      port,
      pool,
      maxRetries: settings.maxRetries,
      targetBaseUrl: settings.targetBaseUrl,
      onAccountSelected(label) {
        showToast(`Using ${label}`, "info")
      },
    })
    proxyStarted = true
  }

  function reloadPool(): void {
    const fresh = loadData()
    pool.updateAccounts(fresh.accounts)
  }

  // Start proxy immediately if accounts exist
  ensureProxy()

  // ── Auth hook: integrates into `opencode auth login` ──

  const authHook: AuthHook = {
    provider: "openai",
    methods: [
      {
        type: "oauth",
        label: "ChatGPT Plus/Pro (multi-account rotation)",
        get prompts(): Prompt[] {
          return buildActionPrompts(pool)
        },

        async authorize(inputs): Promise<AuthOAuthResult> {
          const action = inputs?.action ?? "add_account"

          // ── Add account: real OAuth flow ──
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
                ensureProxy()
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

          // ── Check status ──
          if (action === "check_status") {
            const statuses = pool.getStatus()
            const lines =
              statuses.length === 0
                ? ["No accounts configured."]
                : statuses.map(
                    (s, i) =>
                      `  ${i + 1}. ${s.label} (${s.type}) — ${s.available ? "active" : "rate-limited"}` +
                      (s.tokenExpired ? " [token expired]" : "") +
                      (s.unlocksAt ? ` [unlocks ${s.unlocksAt}]` : ""),
                  )
            return infoResult(`Account Status (${statuses.length}):\n${lines.join("\n")}`)
          }

          // ── Verify one account ──
          if (action === "verify_one") {
            const idx = parseInt(inputs?.verify_target ?? "0", 10)
            const accounts = loadData().accounts
            if (idx < 0 || idx >= accounts.length) {
              return infoResult("Invalid account selection.")
            }
            const acct = accounts[idx]
            const token = acct.type === "oauth" ? acct.accessToken : acct.apiKey
            const result = await verifyAccount(token)
            const status = result.valid ? "Valid" : `Invalid — ${result.error}`
            return infoResult(`${acct.label}: ${status}`)
          }

          // ── Verify all accounts ──
          if (action === "verify_all") {
            const accounts = loadData().accounts
            if (accounts.length === 0) return infoResult("No accounts to verify.")

            const lines: string[] = []
            for (const acct of accounts) {
              const token = acct.type === "oauth" ? acct.accessToken : acct.apiKey
              const result = await verifyAccount(token)
              lines.push(
                `  ${acct.label}: ${result.valid ? "Valid" : `Invalid — ${result.error}`}`,
              )
            }
            return infoResult(`Verification Results:\n${lines.join("\n")}`)
          }

          // ── Select individual account ──
          if (action.startsWith("account:")) {
            const idx = parseInt(action.split(":")[1], 10)
            const accounts = loadData().accounts
            if (idx < 0 || idx >= accounts.length) {
              return infoResult("Account not found.")
            }
            const acct = accounts[idx]
            const token = acct.type === "oauth" ? acct.accessToken : acct.apiKey
            const verification = await verifyAccount(token)

            const info = [
              `Account: ${acct.label}`,
              `Type: ${acct.type}`,
              acct.type === "oauth" ? `Account ID: ${acct.accountId ?? "unknown"}` : "",
              acct.type === "oauth" ? `Token: ${formatTimeSince(acct)}` : "",
              `Status: ${verification.valid ? "Valid" : `Invalid — ${verification.error}`}`,
            ]
              .filter(Boolean)
              .join("\n  ")
            return infoResult(`  ${info}`)
          }

          // ── Delete all accounts ──
          if (action === "delete_all") {
            const data = loadData()
            data.accounts = []
            saveData(data)
            reloadPool()
            console.log("[chatgpt-rotation] All accounts deleted.")
            return infoResult("All accounts have been deleted.")
          }

          return infoResult("Unknown action.")
        },
      },
      {
        type: "api",
        label: "Manually enter API Key",
        prompts: [
          { type: "text", key: "api_key", message: "OpenAI API key", placeholder: "sk-..." },
          { type: "text", key: "label", message: "Label for this key (optional)", placeholder: "my-work-key" },
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
          ensureProxy()
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

    // Point OpenAI provider at our proxy
    async config(cfg) {
      if (pool.size === 0) return
      if (!cfg.provider) cfg.provider = {}
      if (!cfg.provider.openai) cfg.provider.openai = {}
      cfg.provider.openai.baseURL = `http://localhost:${port}`
      delete cfg.provider.openai.apiKey
    },
  }
}
