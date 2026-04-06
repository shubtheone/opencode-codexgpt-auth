import type { Account, OAuthAccount, RateLimitState, AccountStatus, RotationStrategy } from "./types.js"
import { refreshAccessToken } from "./oauth.js"
import { updateOAuthAccountTokens } from "./storage.js"

export class AccountPool {
  private accounts: Account[]
  private readonly strategy: RotationStrategy
  private readonly rateLimits = new Map<string, RateLimitState>()
  private stickyIndex = 0
  private roundRobinIndex = 0

  constructor(accounts: Account[], strategy: RotationStrategy = "sticky") {
    this.accounts = accounts
    this.strategy = strategy
  }

  get size(): number {
    return this.accounts.length
  }

  /** Hot-reload the account list (e.g. after adding a new account). */
  updateAccounts(accounts: Account[]): void {
    this.accounts = accounts
    // Clamp indices
    if (this.stickyIndex >= accounts.length) this.stickyIndex = 0
    if (this.roundRobinIndex >= accounts.length) this.roundRobinIndex = 0
  }

  private labelOf(account: Account): string {
    return account.label
  }

  private isRateLimited(label: string): boolean {
    const state = this.rateLimits.get(label)
    if (!state) return false
    if (Date.now() >= state.until) {
      this.rateLimits.delete(label)
      return false
    }
    return true
  }

  /**
   * Get a valid Bearer token for the given account.
   * For OAuth accounts, auto-refreshes if expired.
   * Returns null if the account can't provide a valid token.
   */
  private async getToken(account: Account): Promise<{ account: Account; token: string } | null> {
    if (account.type === "api_key") {
      return { account, token: account.apiKey }
    }

    // OAuth account — check if access token is still valid (with 60s buffer)
    if (account.expiresAt > Date.now() + 60_000) {
      return { account, token: account.accessToken }
    }

    // Token expired — refresh it
    console.log(`[chatgpt-rotation] Refreshing token for ${account.label}...`)
    let result: { accessToken: string; refreshToken: string; expiresAt: number } | null = null
    try {
      result = await refreshAccessToken(account.refreshToken)
    } catch (error) {
      console.error(`[chatgpt-rotation] Failed to refresh token for ${account.label}`, error)
      return null
    }
    if (!result) {
      console.error(`[chatgpt-rotation] Failed to refresh token for ${account.label}`)
      return null
    }

    // Update in-memory and persist the refreshed token set.
    const updatedAccount: OAuthAccount = {
      ...account,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    }
    const idx = this.accounts.findIndex((candidate) => candidate.label === account.label)
    if (idx !== -1) {
      this.accounts[idx] = updatedAccount
    }

    updateOAuthAccountTokens(account.label, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    })

    return { account: updatedAccount, token: result.accessToken }
  }

  /**
   * Get the next available account and its bearer token.
   * Returns null if all accounts are rate-limited or have invalid tokens.
   */
  async getActiveAccount(
    predicate?: (account: Account) => boolean,
  ): Promise<{ account: Account; token: string; label: string } | null> {
    if (this.accounts.length === 0) return null

    const startIndex = this.strategy === "sticky" ? this.stickyIndex : this.roundRobinIndex

    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (startIndex + i) % this.accounts.length
      const account = this.accounts[idx]
      const label = this.labelOf(account)

      if (predicate && !predicate(account)) continue
      if (this.isRateLimited(label)) continue

      const active = await this.getToken(account)
      if (!active) continue

      // Update indices
      if (this.strategy === "sticky") {
        this.stickyIndex = idx
      }

      return { account: active.account, token: active.token, label }
    }

    return null
  }

  async getActiveToken(
    predicate?: (account: Account) => boolean,
  ): Promise<{ token: string; label: string } | null> {
    const active = await this.getActiveAccount(predicate)
    return active ? { token: active.token, label: active.label } : null
  }

  /** Called after a successful request. */
  onSuccess(label: string): void {
    if (this.strategy === "round-robin") {
      const idx = this.accounts.findIndex((a) => a.label === label)
      if (idx !== -1) {
        this.roundRobinIndex = (idx + 1) % this.accounts.length
      }
    }
  }

  /** Mark an account as rate-limited. */
  onRateLimit(label: string, retryAfterSeconds?: number): void {
    const existing = this.rateLimits.get(label)
    const retries = (existing?.retries ?? 0) + 1

    const backoffMs =
      retryAfterSeconds != null
        ? retryAfterSeconds * 1000
        : Math.min(30_000 * Math.pow(2, retries - 1), 600_000)

    this.rateLimits.set(label, { until: Date.now() + backoffMs, retries })

    // Rotate away from this account
    if (this.strategy === "sticky") {
      const idx = this.accounts.findIndex((a) => a.label === label)
      if (idx === this.stickyIndex) {
        for (let i = 1; i < this.accounts.length; i++) {
          const next = (this.stickyIndex + i) % this.accounts.length
          if (!this.isRateLimited(this.labelOf(this.accounts[next]))) {
            this.stickyIndex = next
            return
          }
        }
      }
    } else {
      const idx = this.accounts.findIndex((a) => a.label === label)
      if (idx !== -1) {
        this.roundRobinIndex = (idx + 1) % this.accounts.length
      }
    }
  }

  getMinWaitMs(): number {
    let min = Infinity
    for (const account of this.accounts) {
      const label = this.labelOf(account)
      if (!this.isRateLimited(label)) return 0
      const state = this.rateLimits.get(label)
      if (!state) return 0
      min = Math.min(min, state.until - Date.now())
    }
    return Math.max(0, min === Infinity ? 0 : min)
  }

  getStatus(): AccountStatus[] {
    return this.accounts.map((account) => {
      const label = this.labelOf(account)
      const state = this.rateLimits.get(label)
      const rateLimited = this.isRateLimited(label)
      const tokenExpired =
        account.type === "oauth" ? account.expiresAt <= Date.now() : undefined

      return {
        label,
        type: account.type,
        available: !rateLimited,
        tokenExpired,
        unlocksAt: state && rateLimited ? new Date(state.until).toISOString() : undefined,
      }
    })
  }
}
