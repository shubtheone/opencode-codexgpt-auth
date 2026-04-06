import { randomBytes, createHash } from "crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import type { Account, OAuthAccount } from "./types.js"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const SCOPE = "openid profile email offline_access"
const JWT_CLAIM_PATH = "https://api.openai.com/auth"
const DEBUG = process.env.CHATGPT_ROTATION_DEBUG === "1"

function debugLog(message: string, error?: unknown): void {
  if (!DEBUG) return
  if (error !== undefined) {
    console.error(message, error)
    return
  }
  console.error(message)
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function generateState(): string {
  return randomBytes(16).toString("base64url")
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8")
    return JSON.parse(payload)
  } catch {
    return null
  }
}

const PROFILE_CLAIM_PATH = "https://api.openai.com/profile"

async function extractAccountInfo(accessToken: string): Promise<{ accountId?: string; email?: string }> {
  const payload = decodeJwtPayload(accessToken)
  const authClaim = payload?.[JWT_CLAIM_PATH]
  const profileClaim = payload?.[PROFILE_CLAIM_PATH]
  const accountId = authClaim?.chatgpt_account_id

  // Email lives in the profile claim, not top-level
  const email = profileClaim?.email ?? payload?.email

  if (email) return { accountId, email }

  // Fallback: fetch from userinfo endpoint
  try {
    const res = await fetch("https://auth.openai.com/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (res.ok) {
      const info = (await res.json()) as { email?: string; name?: string }
      if (info.email) return { accountId, email: info.email }
    }
  } catch {}

  return { accountId, email: payload?.sub }
}

interface OAuthCallbackResult {
  code: string
}

/**
 * Start a temporary local HTTP server to receive the OAuth callback.
 * Returns the port and a promise that resolves with the auth code.
 */
function startCallbackServer(
  expectedState: string,
): Promise<{ port: number; waitForCode: () => Promise<OAuthCallbackResult>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (result: OAuthCallbackResult) => void
    let rejectCode!: (error: Error) => void
    let listening = false
    let codeSettled = false

    const codePromise = new Promise<OAuthCallbackResult>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    function failCode(message: string): void {
      if (codeSettled) return
      codeSettled = true
      rejectCode(new Error(message))
    }

    function completeCode(result: OAuthCallbackResult): void {
      if (codeSettled) return
      codeSettled = true
      resolveCode(result)
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://localhost")

      if (url.pathname !== "/auth/callback") {
        res.writeHead(404)
        res.end("Not found")
        return
      }

      const state = url.searchParams.get("state")
      if (state !== expectedState) {
        res.writeHead(400)
        res.end("State mismatch — possible CSRF attack.")
        failCode("State mismatch during OAuth callback")
        return
      }

      const code = url.searchParams.get("code")
      if (!code) {
        res.writeHead(400)
        res.end("Missing authorization code.")
        failCode("Missing authorization code during OAuth callback")
        return
      }

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(`
        <html><body style="font-family:system-ui;text-align:center;padding:60px;">
          <h2>Account connected!</h2>
          <p>You can close this tab and return to your terminal.</p>
        </body></html>
      `)

      completeCode({ code })
    })

    server.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error))
      failCode(err.message)
      if (!listening) {
        reject(err)
      }
    })

    // Must use port 1455 — OpenAI's allowed redirect URI for this client_id
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      listening = true
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start callback server"))
        return
      }
      resolve({
        port: addr.port,
        waitForCode: () => codePromise,
        close: () => server.close(),
      })
    })
  })
}

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[chatgpt-rotation] Token exchange failed: ${res.status} ${text}`)
    return null
  }

  const json = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!json.access_token || !json.refresh_token || !json.expires_in) {
    console.error("[chatgpt-rotation] Incomplete token response")
    return null
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
  }
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[chatgpt-rotation] Token refresh failed: ${res.status} ${text}`)
      return null
    }

    const json = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }

    if (!json.access_token || !json.expires_in) {
      return null
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken, // some responses reuse the same refresh token
      expiresAt: Date.now() + json.expires_in * 1000,
    }
  } catch (error) {
    console.error("[chatgpt-rotation] Token refresh request failed", error)
    return null
  }
}

/**
 * Verify that an account's token is still valid by hitting the OpenAI models endpoint.
 */
async function verifyApiKeyAccount(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok || res.status === 429) return { valid: true }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Unauthorized — key invalid or revoked" }
    }
    return { valid: false, error: `Verification failed (${res.status})` }
  } catch (error) {
    debugLog("[chatgpt-rotation] API key verification request failed", error)
    return { valid: false, error: "Verification request failed" }
  }
}

async function verifyOAuthAccount(account: OAuthAccount): Promise<{ valid: boolean; error?: string }> {
  let accessToken = account.accessToken

  if (account.expiresAt <= Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(account.refreshToken)
    if (!refreshed) {
      return { valid: false, error: "Token refresh failed" }
    }
    accessToken = refreshed.accessToken
  }

  try {
    const res = await fetch("https://auth.openai.com/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (res.ok || res.status === 429) return { valid: true }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Unauthorized — token invalid or revoked" }
    }
    return { valid: false, error: `Verification failed (${res.status})` }
  } catch (error) {
    debugLog("[chatgpt-rotation] OAuth verification request failed", error)
    return { valid: false, error: "Verification request failed" }
  }
}

export async function verifyAccount(account: Account): Promise<{ valid: boolean; error?: string }> {
  return account.type === "api_key"
    ? verifyApiKeyAccount(account.apiKey)
    : verifyOAuthAccount(account)
}

/**
 * Run the full OAuth flow — opens a browser URL for the user, waits for callback.
 * Returns the new OAuthAccount or null on failure.
 */
export async function runOAuthFlow(): Promise<{
  url: string
  waitForAccount: () => Promise<OAuthAccount | null>
  close: () => void
}> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = computeCodeChallenge(codeVerifier)
  const state = generateState()

  const { waitForCode, close } = await startCallbackServer(state)

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  url.searchParams.set("state", state)
  url.searchParams.set("originator", "opencode")

  return {
    url: url.toString(),
    close,
    async waitForAccount(): Promise<OAuthAccount | null> {
      try {
        const { code } = await waitForCode()
        const tokens = await exchangeCode(code, codeVerifier, REDIRECT_URI)
        if (!tokens) return null

        const info = await extractAccountInfo(tokens.accessToken)

        return {
          type: "oauth",
          label: info.email ?? info.accountId ?? `account-${Date.now()}`,
          accountId: info.accountId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
        }
      } catch (err) {
        console.error("[chatgpt-rotation] OAuth flow error:", err)
        return null
      } finally {
        close()
      }
    },
  }
}
