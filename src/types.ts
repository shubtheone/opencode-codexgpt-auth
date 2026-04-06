export type RotationStrategy = "round-robin" | "sticky"

export interface OAuthAccount {
  type: "oauth"
  label: string
  accountId?: string
  accessToken: string
  refreshToken: string
  expiresAt: number // unix timestamp ms
}

export interface ApiKeyAccount {
  type: "api_key"
  label: string
  apiKey: string
}

export type Account = OAuthAccount | ApiKeyAccount

export interface StoredData {
  accounts: Account[]
  settings: PluginSettings
}

export interface PluginSettings {
  strategy: RotationStrategy
  port: number
  maxRetries: number
  targetBaseUrl: string
}

export interface RateLimitState {
  until: number
  retries: number
}

export interface AccountStatus {
  label: string
  type: "oauth" | "api_key"
  available: boolean
  tokenExpired?: boolean
  unlocksAt?: string
}

export const DEFAULT_SETTINGS: PluginSettings = {
  strategy: "sticky",
  port: 3099,
  maxRetries: 3,
  targetBaseUrl: "https://api.openai.com",
}
