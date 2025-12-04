import { action, computed, observable, runInAction } from "mobx";
import { v4 as uuidv4 } from "uuid";
import { getCookie } from "tiny-cookie";
import { CSRF } from "@shared/constants";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";

/**
 * Represents an AI-generated edit to be applied to a document.
 * Uses persistent blockId for reliable targeting across modifications.
 */
export interface DocumentEdit {
  /** Unique identifier for this edit */
  id: string;
  /** Persistent unique ID of the target block (stable across edits) */
  blockId: string;
  /** Current index of the block (informational, may change) */
  blockIndex: number;
  /** Original content of the block (captured when edit is created) */
  originalContent: string;
  /** New content to replace/insert (markdown format) */
  replaceWith: string;
  /** Action to perform: replace, delete, insertAfter, or moveAfter */
  action: "replace" | "delete" | "insertAfter" | "moveAfter";
  /** Target block ID for moveAfter action (block will be moved to after this block) */
  targetBlockId?: string;
  /** Human-readable description of the edit */
  description: string;
  /** Current status of this edit */
  status: "pending" | "accepted" | "rejected";
}

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  isLoading?: boolean;
  isStreaming?: boolean;
  edits?: DocumentEdit[];
  hasMore?: boolean;
  iteration?: number;
  /** Whether this is a final summary message */
  isSummary?: boolean;
  /** Document diff for summary messages */
  documentDiff?: DocumentDiff;
}

/** Represents the diff between original and modified document */
export interface DocumentDiff {
  /** Original document content (before AI modifications) */
  originalContent: string;
  /** Final document content (after AI modifications) */
  finalContent: string;
  /** Number of lines added */
  linesAdded: number;
  /** Number of lines removed */
  linesRemoved: number;
  /** Document title */
  documentTitle: string;
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
  isStreaming = false;

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
  lastRequest: {
    content: string;
    documentContext?: string;
    mode: "ask" | "agent";
    blocks?: Array<{ blockId: string; index: number; content: string; type: string; editable: boolean }>;
  } | null = null;

  @observable
  clientApiKeys: Record<string, string> = {};

  @observable
  serverHasKeys = false;

  @observable
  currentIteration = 0;

  @observable
  pendingContinuation: string | null = null;

  @observable
  autoApply = true;

  @observable
  contextSummary: string | null = null;

  @observable
  summarizedAtIteration = 0;

  /** Original document content captured at the start of the session */
  @observable
  originalDocumentContent: string | null = null;

  /** Original document title */
  @observable
  originalDocumentTitle: string | null = null;

  // Summarize context every N iterations to avoid context overflow
  private readonly SUMMARIZE_EVERY_N_ITERATIONS = 5;

  currentDocumentId: string | null = null;

  // Callback to get fresh document content for iterations
  private getDocumentContentCallback: (() => { context: string; blocks: Array<{ blockId: string; index: number; content: string; type: string; editable: boolean }> } | null) | null = null;

  private abortController: AbortController | null = null;

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
  get selectedProviderHasKey() {
    // Check if the selected provider is in the providers list (which only contains providers with keys)
    return this.providers.some((p) => p.id === this.selectedProvider);
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
  setCurrentDocument(documentId: string | null) {
    this.currentDocumentId = documentId;
  }

  @action
  setAutoApply(value: boolean) {
    this.autoApply = value;
  }

  // Set callback to get fresh document content for iterations
  setDocumentContentCallback(callback: (() => { context: string; blocks: Array<{ blockId: string; index: number; content: string; type: string; editable: boolean }> } | null) | null) {
    this.getDocumentContentCallback = callback;
  }

  /**
   * Capture the original document content at the start of a session
   */
  @action
  captureOriginalDocument(content: string, title: string) {
    // Only capture if we don't already have an original (new session)
    if (!this.originalDocumentContent) {
      this.originalDocumentContent = content;
      this.originalDocumentTitle = title;
      console.log("[AI Chat] Captured original document content, length:", content.length);
    }
  }

  /**
   * Reset the original document capture (for new sessions)
   */
  @action
  resetOriginalDocument() {
    this.originalDocumentContent = null;
    this.originalDocumentTitle = null;
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
    this.currentIteration = 0;
    this.pendingContinuation = null;
    this.saveToStorage();
  }

  @action
  stopStreaming() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isStreaming = false;
    this.isLoading = false;
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
  async sendMessage(
    content: string,
    documentContext?: string,
    mode: "ask" | "agent" = "ask",
    blocks?: Array<{ blockId: string; index: number; content: string; type: string; editable: boolean }>
  ) {
    // Use streaming version
    await this.sendMessageStream(content, documentContext, mode, blocks);
  }

  @action
  async sendMessageStream(
    content: string,
    documentContext?: string,
    mode: "ask" | "agent" = "ask",
    blocks?: Array<{ blockId: string; index: number; content: string; type: string; editable: boolean }>,
    continueFrom?: string
  ) {
    // Prevent duplicate sends
    if (this.isLoading || this.isStreaming) {
      return;
    }

    this.error = null;
    this.isLoading = true;
    this.isStreaming = true;
    this.lastRequest = { content, documentContext, mode, blocks };

    // Only add user message if this is not a continuation
    if (!continueFrom) {
      this.currentIteration = 1;
      // Reset context summary for new conversations
      this.contextSummary = null;
      this.summarizedAtIteration = 0;

      // Capture original document content for diff at the end (agent mode only)
      if (mode === "agent" && documentContext) {
        // Get document title from the store if available
        const docTitle = this.rootStore.documents.get(this.currentDocumentId || "")?.title || "Document";
        this.captureOriginalDocument(documentContext, docTitle);
      }

      this.addMessage("user", content);
    } else {
      this.currentIteration++;
    }

    const streamingMessage: AiChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "",
      createdAt: new Date(),
      isLoading: false,
      isStreaming: true,
      iteration: this.currentIteration,
    };

    this.messages.push(streamingMessage);

    // Store blocks for later use
    const blockMap = new Map(blocks?.map(b => [b.blockId, {
      index: b.index,
      content: b.content,
      type: b.type,
      editable: b.editable
    }]) || []);

    // Create abort controller for this request
    this.abortController = new AbortController();

    try {
      // Build conversation history
      // Use effective history (with summarization if needed)
      const conversationHistory = this.effectiveHistory;

      const clientApiKey = this.selectedProvider
        ? this.clientApiKeys[this.selectedProvider]
        : undefined;

      // Get CSRF token for authentication
      const csrfToken = getCookie(CSRF.cookieName);

      const response = await fetch("/api/ai.chat.stream", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken && { [CSRF.headerName]: csrfToken }),
        },
        body: JSON.stringify({
          message: content,
          documentContext,
          history: conversationHistory,
          provider: this.selectedProvider,
          model: this.selectedModel,
          mode,
          clientApiKey: clientApiKey || undefined,
          continueFrom,
          maxEditsPerIteration: 12, // Optimized for modern AI models
          iterationCount: continueFrom ? this.currentIteration + 1 : 1,
          // Include context summary if available
          contextSummary: this.contextSummary || undefined,
          summarizedAtIteration: this.summarizedAtIteration,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("event: ")) {
            // Parse event type
            continue;
          }

          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));

              if (data.content) {
                // Streaming chunk - update message content
                // In agent mode, don't show raw JSON during streaming
                // Just show a loading indicator
                runInAction(() => {
                  const index = this.messages.findIndex(m => m.id === streamingMessage.id);
                  if (index !== -1) {
                    if (mode === "agent") {
                      // For agent mode, show generic processing message
                      // The actual response will come in the complete event
                      this.messages[index] = {
                        ...this.messages[index],
                        content: "⏳ Analyse et modification du document en cours...",
                      };
                    } else {
                      this.messages[index] = {
                        ...this.messages[index],
                        content: this.messages[index].content + data.content,
                      };
                    }
                  }
                });
              }

              if (data.response !== undefined) {
                // Complete event
                runInAction(() => {
                  const index = this.messages.findIndex(m => m.id === streamingMessage.id);
                  if (index !== -1) {
                    // Parse edits if in agent mode
                    let edits: DocumentEdit[] | undefined;
                    if (mode === "agent" && data.edits && Array.isArray(data.edits)) {
                      edits = data.edits.map((edit: {
                        blockId: string;
                        replaceWith?: string;
                        action: string;
                        targetBlockId?: string;
                        description?: string;
                      }) => {
                        const blockInfo = blockMap.get(edit.blockId);
                        return {
                          id: uuidv4(),
                          blockId: edit.blockId,
                          blockIndex: blockInfo?.index ?? -1,
                          originalContent: blockInfo?.content || "",
                          replaceWith: edit.replaceWith || "",
                          action: edit.action as "replace" | "delete" | "insertAfter" | "moveAfter",
                          targetBlockId: edit.targetBlockId,
                          description: edit.description || "",
                          status: "pending" as const,
                        };
                      });
                    }

                    this.messages[index] = {
                      ...this.messages[index],
                      content: data.response,
                      isStreaming: false,
                      edits,
                      hasMore: data.hasMore,
                    };

                    // Auto-apply edits if enabled - SEQUENTIAL like Copilot
                    if (this.autoApply && edits && edits.length > 0 && this.currentDocumentId) {
                      const currentDocId = this.currentDocumentId;

                      // Apply edits SEQUENTIALLY with verification
                      const applyEditSequentially = async (editIndex: number): Promise<void> => {
                        if (editIndex >= edits.length) {
                          // All edits applied, continue if needed
                          if (data.hasMore && this.currentDocumentId) {
                            // Wait a bit for document to stabilize
                            await new Promise(r => setTimeout(r, 200));
                            runInAction(() => {
                              void this.continueIteration();
                            });
                          }
                          return;
                        }

                        const edit = edits[editIndex];

                        // Create promise to wait for this specific edit
                        const editAppliedPromise = new Promise<void>((resolve) => {
                          const handleEditApplied = (e: CustomEvent) => {
                            if (e.detail.documentId === currentDocId) {
                              window.removeEventListener("ai-edit-applied", handleEditApplied as EventListener);
                              resolve();
                            }
                          };
                          window.addEventListener("ai-edit-applied", handleEditApplied as EventListener);

                          // Fallback timeout
                          setTimeout(() => {
                            window.removeEventListener("ai-edit-applied", handleEditApplied as EventListener);
                            resolve();
                          }, 2000);
                        });

                        // Dispatch the edit
                        const event = new CustomEvent("ai-apply-edit", {
                          detail: {
                            documentId: currentDocId,
                            edit: {
                              blockId: edit.blockId,
                              replaceWith: edit.replaceWith,
                              action: edit.action,
                              targetBlockId: edit.targetBlockId,
                            },
                          },
                        });
                        window.dispatchEvent(event);
                        edit.status = "accepted";

                        // Wait for edit to be applied
                        await editAppliedPromise;

                        // Small delay between edits for stability
                        await new Promise(r => setTimeout(r, 50));

                        // Apply next edit
                        await applyEditSequentially(editIndex + 1);
                      };

                      // Start sequential application
                      void applyEditSequentially(0);

                    } else if (data.hasMore && this.autoApply && this.currentDocumentId) {
                      // No edits but hasMore, continue after a delay
                      setTimeout(() => {
                        void this.continueIteration();
                      }, 500);
                    }

                    // Store continuation info if more work is needed
                    if (data.hasMore) {
                      this.pendingContinuation = data.rawContent || data.response;
                    } else {
                      this.pendingContinuation = null;

                      // Generate final summary if we had multiple iterations
                      if (this.currentIteration > 1) {
                        this.generateFinalSummary();
                      }
                    }
                  }
                });
              }

              if (data.message) {
                // Error event
                throw new Error(data.message);
              }
            } catch (parseError) {
              // Skip invalid JSON
              if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") {
                console.error("[AI Stream] Parse error:", parseError);
              }
            }
          }
        }
      }

      runInAction(() => {
        this.isLoading = false;
        this.isStreaming = false;
        this.saveToStorage();
      });

    } catch (err: unknown) {
      runInAction(() => {
        // Check if it was aborted
        if (err instanceof Error && err.name === "AbortError") {
          // Clean up the streaming message
          const index = this.messages.findIndex(m => m.id === streamingMessage.id);
          if (index !== -1) {
            this.messages[index] = {
              ...this.messages[index],
              isStreaming: false,
              content: this.messages[index].content || "(Cancelled)",
            };
          }
        } else {
          // Remove streaming message on error
          const index = this.messages.findIndex(m => m.id === streamingMessage.id);
          if (index !== -1) {
            this.messages.splice(index, 1);
          }
          this.error = err instanceof Error ? err.message : "Failed to get AI response";
        }
        this.isLoading = false;
        this.isStreaming = false;
      });
    }
  }

  @action
  async continueIteration() {
    if (!this.pendingContinuation || !this.lastRequest) {
      return;
    }

    const { content, mode } = this.lastRequest;

    // Get fresh document content if callback is available
    let documentContext = this.lastRequest.documentContext;
    let blocks = this.lastRequest.blocks;

    if (this.getDocumentContentCallback) {
      const freshContent = this.getDocumentContentCallback();
      if (freshContent) {
        documentContext = freshContent.context;
        blocks = freshContent.blocks;
        console.log("[AI Chat] Using fresh document content for iteration, length:", documentContext?.length);
      }
    }

    // Check if we need to summarize the context (every N iterations)
    const iterationsSinceSummary = this.currentIteration - this.summarizedAtIteration;
    if (iterationsSinceSummary >= this.SUMMARIZE_EVERY_N_ITERATIONS) {
      console.log("[AI Chat] Summarizing context after", iterationsSinceSummary, "iterations");
      await this.summarizeContext();
    }

    await this.sendMessageStream(content, documentContext, mode, blocks, this.pendingContinuation);
  }

  /**
   * Summarizes the current conversation context to reduce token usage
   * Similar to GitHub Copilot's context management
   */
  @action
  private async summarizeContext() {
    // Build a summary of what was done
    const completedEdits = this.messages
      .filter(m => m.role === "assistant" && m.edits && m.edits.length > 0)
      .flatMap(m => m.edits || []);

    const editSummary = completedEdits.length > 0
      ? `Modifications effectuées (${completedEdits.length} au total):\n` +
      completedEdits.slice(-15).map(e => `- ${e.action}: ${e.description || "modification"}`).join("\n")
      : "Aucune modification encore.";

    // Get the original request
    const originalRequest = this.lastRequest?.content || "";

    // Get the last assistant message that mentioned remaining work
    const lastAssistantMessages = this.messages
      .filter(m => m.role === "assistant" && m.hasMore && m.content)
      .slice(-2);

    const remainingWork = lastAssistantMessages.length > 0
      ? `TRAVAIL RESTANT (d'après la dernière itération):\n${lastAssistantMessages.map(m => m.content).join("\n---\n")}`
      : "";

    // Build the context summary - IMPORTANT: keep remaining work info
    this.contextSummary = `=== RÉSUMÉ DU CONTEXTE (après itération ${this.currentIteration}) ===

REQUÊTE ORIGINALE DE L'UTILISATEUR:
${originalRequest}

${editSummary}

${remainingWork}

⚠️ IMPORTANT: Vérifiez le document ci-dessous et continuez le travail restant. Ne pas terminer tant que la requête originale n'est pas complètement satisfaite.`;

    this.summarizedAtIteration = this.currentIteration;

    console.log("[AI Chat] Context summarized, new summary length:", this.contextSummary.length);
  }

  /**
   * Generates a final summary of all changes made across iterations
   * Similar to GitHub Copilot's completion summary
   */
  @action
  private generateFinalSummary() {
    // Collect all assistant messages that had edits (the explanations of what was done)
    const assistantMessages = this.messages
      .filter(m => m.role === "assistant" && !m.isSummary && !m.isStreaming && m.content);

    // Count total edits
    const totalEdits = this.messages
      .filter(m => m.role === "assistant" && m.edits && m.edits.length > 0)
      .reduce((acc, m) => acc + (m.edits?.length || 0), 0);

    if (totalEdits === 0 && assistantMessages.length === 0) {
      return; // Nothing to summarize
    }

    // Extract key actions from assistant messages (what was actually done)
    const actionsSummary: string[] = [];

    for (const msg of assistantMessages) {
      // Extract the main action description from each iteration's response
      // Usually the first sentence or paragraph explains what was done
      const content = msg.content.trim();

      // Skip very short or generic messages
      if (content.length < 20) continue;

      // Get the first meaningful sentence/paragraph
      const firstPart = content.split(/\n\n/)[0];
      if (firstPart && firstPart.length > 10 && firstPart.length < 300) {
        // Clean up and add
        const cleaned = firstPart
          .replace(/^(J'ai |I have |I've |Voici |Here )/i, '')
          .replace(/\.$/, '');
        if (cleaned.length > 10) {
          actionsSummary.push(cleaned);
        }
      }
    }

    // Build a concise summary
    let summaryContent = `## ✅ Travail terminé\n\n`;

    if (actionsSummary.length > 0) {
      // Show unique actions (deduplicate similar ones)
      const uniqueActions = [...new Set(actionsSummary)].slice(0, 8);
      for (const action of uniqueActions) {
        summaryContent += `- ${action}\n`;
      }
    }

    // Calculate document diff if we have original content
    let documentDiff: DocumentDiff | undefined;
    if (this.originalDocumentContent && this.getDocumentContentCallback) {
      const currentContent = this.getDocumentContentCallback();
      if (currentContent) {
        const cleanOriginal = this.cleanDocumentContent(this.originalDocumentContent);
        const cleanFinal = this.cleanDocumentContent(currentContent.context);

        const originalLines = cleanOriginal.split('\n');
        const finalLines = cleanFinal.split('\n');

        const { added, removed } = this.calculateLineDiff(originalLines, finalLines);

        documentDiff = {
          originalContent: cleanOriginal,
          finalContent: cleanFinal,
          linesAdded: added,
          linesRemoved: removed,
          documentTitle: this.originalDocumentTitle || "Document",
        };

        console.log("[AI Chat] Document diff calculated:", added, "lines added,", removed, "lines removed");
      }
    }

    // Add summary message with diff
    const summaryMessage: AiChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: summaryContent,
      createdAt: new Date(),
      isSummary: true,
      documentDiff,
    };

    this.messages.push(summaryMessage);
    this.saveToStorage();

    // Reset original document for next session
    this.resetOriginalDocument();

    console.log("[AI Chat] Final summary generated with", totalEdits, "edits across", this.currentIteration, "iterations");
  }

  /**
   * Clean document content by removing block IDs for cleaner diff
   */
  private cleanDocumentContent(content: string): string {
    return content
      .replace(/\[ID:blk_[^\]]+\]\s*/g, '')
      .replace(/\[LIST:blk_[^\]]+\][^\n]*\n/g, '')
      .replace(/\[ITEM:blk_[^\]]+\]\s*-?\s*/g, '• ')
      .replace(/\[NON-EDITABLE:[^\]]+\]\s*/g, '')
      .trim();
  }

  /**
   * Calculate simple line diff (added/removed count)
   */
  private calculateLineDiff(originalLines: string[], finalLines: string[]): { added: number; removed: number } {
    const originalSet = new Set(originalLines.map(l => l.trim()).filter(l => l));
    const finalSet = new Set(finalLines.map(l => l.trim()).filter(l => l));

    let added = 0;
    let removed = 0;

    for (const line of finalSet) {
      if (!originalSet.has(line)) {
        added++;
      }
    }

    for (const line of originalSet) {
      if (!finalSet.has(line)) {
        removed++;
      }
    }

    return { added, removed };
  }

  /**
   * Get the effective conversation history (with summarization)
   * Note: Only returns user/assistant messages, contextSummary is sent separately
   */
  @computed
  get effectiveHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    // Filter out system messages, summary messages, and loading states
    const validMessages = this.messages.filter(m =>
      (m.role === "user" || m.role === "assistant") &&
      !m.isLoading &&
      !m.isStreaming &&
      !m.isSummary
    );

    // If we have a summary, only include messages AFTER the summarization point
    if (this.contextSummary && this.summarizedAtIteration > 0) {
      const recentMessages = validMessages
        .filter(m => {
          const iteration = m.iteration || 0;
          return iteration > this.summarizedAtIteration;
        })
        .slice(-6);  // Keep only last 6 messages after summary

      return recentMessages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    }

    // No summary yet, use normal history (last 10 messages)
    return validMessages
      .slice(-10)
      .map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }

  @action
  async retry() {
    if (!this.lastRequest || this.isLoading || this.isStreaming) {
      return;
    }

    this.error = null;
    const { content, documentContext, mode, blocks } = this.lastRequest;
    await this.sendMessageStream(content, documentContext, mode, blocks);
  }
}

export default AiChatStore;
