import type { AccountPool } from "./accounts.js"

export interface ProxyConfig {
  port: number
  pool: AccountPool
  maxRetries?: number
  targetBaseUrl?: string
  /** Called when an account is selected for a request */
  onAccountSelected?: (label: string) => void
}

function parseRetryAfter(headers: Headers): number | undefined {
  const val = headers.get("retry-after")
  if (!val) return undefined
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? undefined : parsed
}

export function startProxyServer(config: ProxyConfig): void {
  const { port, pool, maxRetries = 3, targetBaseUrl = "https://api.openai.com" } = config

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      // Status endpoint
      if (url.pathname === "/__rotation_status") {
        return Response.json({
          accounts: pool.getStatus(),
          totalAccounts: pool.size,
        })
      }

      const targetUrl = `${targetBaseUrl}${url.pathname}${url.search}`

      // Buffer body for retries
      const bodyBuffer =
        req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : null

      // Copy headers, strip auth-related ones (we inject our own)
      const baseHeaders = new Headers()
      for (const [k, v] of req.headers.entries()) {
        const lower = k.toLowerCase()
        if (lower === "host" || lower === "authorization" || lower === "connection") continue
        baseHeaders.set(k, v)
      }

      let lastResponse: Response | null = null

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const active = await pool.getActiveToken()

        if (!active) {
          const waitSec = Math.ceil(pool.getMinWaitMs() / 1000)
          console.warn(
            `[chatgpt-rotation] All accounts unavailable. Retry in ${waitSec}s.`,
          )
          return Response.json(
            {
              error: {
                message: `All accounts are rate-limited or have invalid tokens. Retry in ${waitSec}s.`,
                type: "rate_limit_error",
                code: "all_accounts_exhausted",
              },
            },
            { status: 429, headers: { "Retry-After": String(waitSec) } },
          )
        }

        // Notify which account is being used (only on first attempt)
        if (attempt === 0) {
          config.onAccountSelected?.(active.label)
        }

        const headers = new Headers(baseHeaders)
        headers.set("Authorization", `Bearer ${active.token}`)

        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: bodyBuffer,
        })

        if (upstream.status === 429) {
          const retryAfter = parseRetryAfter(upstream.headers)
          pool.onRateLimit(active.label, retryAfter)
          console.warn(
            `[chatgpt-rotation] Account "${active.label}" rate-limited` +
              (retryAfter ? ` (retry-after ${retryAfter}s)` : "") +
              `. Attempt ${attempt + 1}/${maxRetries}.`,
          )
          lastResponse = upstream
          await Bun.sleep(300)
          continue
        }

        if (upstream.ok) {
          pool.onSuccess(active.label)
        }

        // Pipe response through (handles streaming SSE transparently)
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        })
      }

      // All retries exhausted
      if (lastResponse) {
        const body = await lastResponse.text()
        return new Response(body, {
          status: 429,
          headers: lastResponse.headers,
        })
      }

      return Response.json(
        { error: { message: "Max retries exceeded", type: "proxy_error" } },
        { status: 429 },
      )
    },
  })

  console.log(`[chatgpt-rotation] Proxy listening on http://localhost:${port}`)
  console.log(`[chatgpt-rotation] Rotating across ${pool.size} account(s)`)
  console.log(`[chatgpt-rotation] Status: http://localhost:${port}/__rotation_status`)
}
