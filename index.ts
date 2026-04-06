import { ChatGPTRotationPlugin } from "./src/index.js"

export { ChatGPTRotationPlugin }
export type { Account, OAuthAccount, ApiKeyAccount, PluginSettings } from "./src/types.js"

// OpenCode expects PluginModule format: { id?, server, tui? }
export default {
  id: "opencode-chatgpt-rotation",
  server: ChatGPTRotationPlugin,
}
