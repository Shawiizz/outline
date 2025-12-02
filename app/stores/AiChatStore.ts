import { action, computed, observable, runInAction } from "mobx";
import { v4 as uuidv4 } from "uuid";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";

export interface DocumentEdit {
  id: string;
  // Line-based edit (new system)
  startLine?: number;
  endLine?: number;
  insert?: boolean;
  // Legacy fields for display
  type: "replace" | "insert" | "delete" | "prepend" | "append" | "replaceAll";
  description: string;
  oldContent?: string;
  newContent: string;
  status: "pending" | "accepted" | "rejected";
}

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  isLoading?: boolean;
  edits?: DocumentEdit[];
}

export interface AiModel {
  id: string;
  name: string;
}

export interface AiProvider {
  id: string;
  name: string;
  models: AiModel[];
}

export interface AvailableProvider {
  id: string;
  name: string;
}

const AI_CHAT_STORAGE_KEY = "AI_CHAT_MESSAGES";
const AI_CHAT_SETTINGS_KEY = "AI_CHAT_SETTINGS";
const AI_CHAT_API_KEYS_KEY = "AI_CHAT_API_KEYS";

class AiChatStore {
  @observable
  messages: AiChatMessage[] = [];

  @observable
  isLoading = false;

  @observable
  error: string | null = null;

  @observable
  providers: AiProvider[] = [];

  @observable
  availableProviders: AvailableProvider[] = [];

  @observable
  selectedProvider: string | null = null;

  @observable
  selectedModel: string | null = null;

  @observable
  modelsLoaded = false;

  @observable
  lastRequest: { content: string; documentContext?: string; mode: "ask" | "agent" } | null = null;

  @observable
  clientApiKeys: Record<string, string> = {};

  @observable
  serverHasKeys = false;

  rootStore: RootStore;

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
    this.loadFromStorage();
    this.loadSettings();
    this.loadApiKeys();
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(AI_CHAT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Filter out any loading messages that might have been saved incorrectly
        // and ensure clean state on load
        this.messages = parsed
          .filter((msg: AiChatMessage) => !msg.isLoading)
          .map((msg: AiChatMessage) => ({
            ...msg,
            createdAt: new Date(msg.createdAt),
          }));
      }
    } catch (e) {
      console.error("Failed to load AI chat messages from storage", e);
      // Clear corrupted storage
      localStorage.removeItem(AI_CHAT_STORAGE_KEY);
    }
  }

  private saveToStorage() {
    try {
      // Only save messages that have a response (filter out orphan user messages)
      const messagesToSave = this.messages.filter((msg, index, arr) => {
        if (msg.role === "assistant") return true;
        // Keep user message only if followed by an assistant message
        const nextMsg = arr[index + 1];
        return nextMsg && nextMsg.role === "assistant" && !nextMsg.isLoading;
      });
      localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(messagesToSave));
    } catch (e) {
      console.error("Failed to save AI chat messages to storage", e);
    }
  }

  private loadSettings() {
    try {
      const stored = localStorage.getItem(AI_CHAT_SETTINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.selectedProvider = parsed.provider;
        this.selectedModel = parsed.model;
      }
    } catch (e) {
      console.error("Failed to load AI chat settings from storage", e);
    }
  }

  private saveSettings() {
    try {
      localStorage.setItem(
        AI_CHAT_SETTINGS_KEY,
        JSON.stringify({
          provider: this.selectedProvider,
          model: this.selectedModel,
        })
      );
    } catch (e) {
      console.error("Failed to save AI chat settings to storage", e);
    }
  }

  private loadApiKeys() {
    try {
      const stored = localStorage.getItem(AI_CHAT_API_KEYS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.clientApiKeys = parsed || {};
      }
    } catch (e) {
      console.error("Failed to load AI API keys from storage", e);
    }
  }

  private saveApiKeys() {
    try {
      localStorage.setItem(
        AI_CHAT_API_KEYS_KEY,
        JSON.stringify(this.clientApiKeys)
      );
    } catch (e) {
      console.error("Failed to save AI API keys to storage", e);
    }
  }

  @computed
  get hasClientApiKeys() {
    return Object.values(this.clientApiKeys).some(key => !!key);
  }

  @computed
  get needsApiKeyConfiguration() {
    return !this.serverHasKeys && !this.hasClientApiKeys;
  }

  @computed
  get hasMessages() {
    return this.messages.length > 0;
  }

  @computed
  get currentProvider() {
    return this.providers.find((p) => p.id === this.selectedProvider);
  }

  @computed
  get availableModels() {
    return this.currentProvider?.models || [];
  }

  @action
  setProvider(providerId: string) {
    this.selectedProvider = providerId;
    const provider = this.providers.find((p) => p.id === providerId);
    if (provider && provider.models.length > 0) {
      this.selectedModel = provider.models[0].id;
    }
    this.saveSettings();
  }

  @action
  setModel(modelId: string) {
    this.selectedModel = modelId;
    this.saveSettings();
  }

  @action
  setClientApiKey(providerId: string, key: string | null) {
    if (key) {
      this.clientApiKeys[providerId] = key;
    } else {
      delete this.clientApiKeys[providerId];
    }
    this.saveApiKeys();
    // Reload models to update available providers
    this.modelsLoaded = false;
    void this.loadModels();
  }

  @action
  clearClientApiKeys() {
    this.clientApiKeys = {};
    this.saveApiKeys();
    // Reload models to update available providers
    this.modelsLoaded = false;
    void this.loadModels();
  }

  // Legacy methods for backward compatibility
  @action
  setClientOpenAIKey(key: string | null) {
    this.setClientApiKey("openai", key);
  }

  @action
  setClientGeminiKey(key: string | null) {
    this.setClientApiKey("gemini", key);
  }

  @action
  async loadModels() {
    if (this.modelsLoaded) return;

    try {
      const response = await client.post("/ai.models", {
        clientApiKeys: Object.keys(this.clientApiKeys).length > 0 ? this.clientApiKeys : undefined,
      }, { retry: false });
      runInAction(() => {
        this.providers = response.data.providers;
        this.availableProviders = response.data.availableProviders || [];
        this.serverHasKeys = response.data.serverHasKeys || false;
        if (!this.selectedProvider && response.data.defaultProvider) {
          this.selectedProvider = response.data.defaultProvider;
        }
        if (!this.selectedModel && response.data.defaultModel) {
          this.selectedModel = response.data.defaultModel;
        }
        this.modelsLoaded = true;
      });
    } catch (e) {
      console.error("Failed to load AI models", e);
    }
  }

  @action
  addMessage(role: "user" | "assistant", content: string, edits?: DocumentEdit[]) {
    const message: AiChatMessage = {
      id: uuidv4(),
      role,
      content,
      createdAt: new Date(),
      edits,
    };
    this.messages.push(message);
    this.saveToStorage();
    return message;
  }

  @action
  clearMessages() {
    this.messages = [];
    this.saveToStorage();
  }

  @action
  updateEditStatus(messageId: string, editId: string, status: "accepted" | "rejected") {
    const message = this.messages.find(m => m.id === messageId);
    if (message && message.edits) {
      const edit = message.edits.find(e => e.id === editId);
      if (edit) {
        edit.status = status;
        this.saveToStorage();
      }
    }
  }

  @action
  async sendMessage(content: string, documentContext?: string, mode: "ask" | "agent" = "ask") {
    // Prevent duplicate sends
    if (this.isLoading) {
      console.log("[AiChat] Already loading, ignoring duplicate send");
      return;
    }

    this.error = null;
    this.isLoading = true; // Set loading FIRST to prevent race conditions
    this.lastRequest = { content, documentContext, mode };
    this.addMessage("user", content);

    const loadingMessage: AiChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "",
      createdAt: new Date(),
      isLoading: true,
    };

    this.messages.push(loadingMessage);

    try {
      // Build conversation history for context
      const conversationHistory = this.messages
        .filter(m => !m.isLoading)
        .slice(-10) // Keep last 10 messages for context
        .map(m => ({
          role: m.role,
          content: m.content,
        }));

      // Get the appropriate client API key for the selected provider
      const clientApiKey = this.selectedProvider
        ? this.clientApiKeys[this.selectedProvider]
        : undefined;

      const response = await client.post("/ai.chat", {
        message: content,
        documentContext,
        history: conversationHistory,
        provider: this.selectedProvider,
        model: this.selectedModel,
        mode,
        clientApiKey: clientApiKey || undefined,
      }, { retry: false, timeout: 180000 }); // 3 minute timeout for AI requests

      runInAction(() => {
        const index = this.messages.findIndex(m => m.id === loadingMessage.id);
        if (index !== -1) {
          // Parse edits from response if in agent mode
          let edits: DocumentEdit[] | undefined;
          if (mode === "agent" && response.data.edits) {
            edits = response.data.edits.map((edit: {
              startLine?: number;
              endLine?: number;
              insert?: boolean;
              newContent?: string;
              // Legacy fields
              type?: string;
              description?: string;
              oldContent?: string;
            }) => {
              // Determine edit type based on new line-based format
              let type: "replace" | "insert" | "delete" = "replace";
              let description = "Edit";

              if (edit.startLine !== undefined) {
                // New line-based format
                if (edit.insert) {
                  type = "insert";
                  description = `Insert at line ${edit.startLine}`;
                } else if (!edit.newContent || edit.newContent === "") {
                  type = "delete";
                  description = `Delete lines ${edit.startLine}-${edit.endLine || edit.startLine}`;
                } else {
                  type = "replace";
                  description = `Replace lines ${edit.startLine}-${edit.endLine || edit.startLine}`;
                }
              } else {
                // Legacy format
                type = (edit.type as "replace" | "insert" | "delete") || "replace";
                description = edit.description || "Edit";
              }

              return {
                id: uuidv4(),
                startLine: edit.startLine,
                endLine: edit.endLine,
                insert: edit.insert,
                type,
                description,
                oldContent: edit.oldContent,
                newContent: edit.newContent || "",
                status: "pending" as const,
              };
            });
          }

          this.messages[index] = {
            ...loadingMessage,
            content: response.data.response,
            isLoading: false,
            edits,
          };
        }
        this.isLoading = false;
        this.saveToStorage();
      });
    } catch (err: unknown) {
      runInAction(() => {
        // Remove loading message on error
        const index = this.messages.findIndex(m => m.id === loadingMessage.id);
        if (index !== -1) {
          this.messages.splice(index, 1);
        }
        this.isLoading = false;
        this.error = err instanceof Error ? err.message : "Failed to get AI response";
      });
    }
  }

  @action
  async retry() {
    if (!this.lastRequest || this.isLoading) {
      return;
    }

    this.error = null;
    const { content, documentContext, mode } = this.lastRequest;
    await this.sendMessage(content, documentContext, mode);
  }
}

export default AiChatStore;
