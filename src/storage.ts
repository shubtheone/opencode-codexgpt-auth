import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { Account, StoredData, PluginSettings } from "./types.js"
import { DEFAULT_SETTINGS } from "./types.js"

const STORAGE_DIR = join(homedir(), ".config", "opencode")
const STORAGE_FILE = join(STORAGE_DIR, "chatgpt-rotation.json")

function ensureDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true })
  }
}

export function loadData(): StoredData {
  if (!existsSync(STORAGE_FILE)) {
    return { accounts: [], settings: { ...DEFAULT_SETTINGS } }
  }
  try {
    const raw = readFileSync(STORAGE_FILE, "utf-8")
    const data = JSON.parse(raw) as Partial<StoredData>
    return {
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      settings: { ...DEFAULT_SETTINGS, ...data.settings },
    }
  } catch {
    return { accounts: [], settings: { ...DEFAULT_SETTINGS } }
  }
}

export function saveData(data: StoredData): void {
  ensureDir()
  writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function addAccount(account: Account): void {
  const data = loadData()
  // Avoid duplicates by label
  const existing = data.accounts.findIndex((a) => a.label === account.label)
  if (existing !== -1) {
    data.accounts[existing] = account
  } else {
    data.accounts.push(account)
  }
  saveData(data)
}

export function removeAccount(label: string): boolean {
  const data = loadData()
  const before = data.accounts.length
  data.accounts = data.accounts.filter((a) => a.label !== label)
  if (data.accounts.length === before) return false
  saveData(data)
  return true
}

export function updateAccount(label: string, update: Partial<Account>): void {
  const data = loadData()
  const idx = data.accounts.findIndex((a) => a.label === label)
  if (idx !== -1) {
    data.accounts[idx] = { ...data.accounts[idx], ...update } as Account
    saveData(data)
  }
}

export function getSettings(): PluginSettings {
  return loadData().settings
}

export function getStoragePath(): string {
  return STORAGE_FILE
}
