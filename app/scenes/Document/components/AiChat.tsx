import MarkdownIt from "markdown-it";
import { observer } from "mobx-react";
import { CheckmarkIcon, CloseIcon, DocumentIcon, SparklesIcon, TrashIcon, RestoreIcon, SettingsIcon, CloudIcon, GoToIcon } from "outline-icons";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { useRouteMatch } from "react-router-dom";
import styled, { useTheme, keyframes, css } from "styled-components";
import { s } from "@shared/styles";
import { Avatar } from "~/components/Avatar";
import ButtonSmall from "~/components/ButtonSmall";
import Flex from "~/components/Flex";
import { ArrowDownIcon } from "~/components/Icons/ArrowIcon";
import NudeButton from "~/components/NudeButton";
import Scrollable from "~/components/Scrollable";
import Spinner from "@shared/components/Spinner";
import Tooltip from "~/components/Tooltip";
import useCurrentUser from "~/hooks/useCurrentUser";
import useKeyDown from "~/hooks/useKeyDown";
import useStores from "~/hooks/useStores";
import { ProsemirrorHelper } from "~/models/helpers/ProsemirrorHelper";
import type { DocumentEdit, DocumentDiff } from "~/stores/AiChatStore";
import Sidebar from "./SidebarLayout";

// Initialize markdown-it for rendering AI responses
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});

type ChatMode = "ask" | "agent";

function AiChat() {
  const { ui, aiChat, documents } = useStores();
  const user = useCurrentUser();
  const { t } = useTranslation();
  const theme = useTheme();
  const match = useRouteMatch<{ documentSlug: string }>();
  const document = documents.get(match.params.documentSlug);

  const [inputValue, setInputValue] = React.useState("");
  const [showModelPicker, setShowModelPicker] = React.useState(false);
  const [chatMode, setChatMode] = React.useState<ChatMode>(() => {
    const saved = localStorage.getItem("AI_CHAT_MODE");
    return (saved === "agent" || saved === "ask") ? saved : "ask";
  });
  const [includeContext, setIncludeContext] = React.useState(() => {
    return localStorage.getItem("AI_CHAT_INCLUDE_CONTEXT") === "true";
  });
  const [showApiKeySettings, setShowApiKeySettings] = React.useState(false);
  const [apiKeyDropdownPosition, setApiKeyDropdownPosition] = React.useState<{ top: number; right: number } | null>(null);
  const [modelPickerPosition, setModelPickerPosition] = React.useState<{ bottom: number; left: number } | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const scrollableRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const modelPickerRef = React.useRef<HTMLDivElement | null>(null);
  const modelPickerButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const bottomRowRef = React.useRef<HTMLDivElement | null>(null);
  const [isCompact, setIsCompact] = React.useState(false);
  const apiKeySettingsRef = React.useRef<HTMLDivElement | null>(null);
  const apiKeyButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [expandedDiffs, setExpandedDiffs] = React.useState<Set<string>>(new Set());

  // Toggle diff expansion for a message
  const toggleDiffExpansion = React.useCallback((messageId: string) => {
    setExpandedDiffs(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  // Save chat mode to localStorage when it changes
  React.useEffect(() => {
    localStorage.setItem("AI_CHAT_MODE", chatMode);
  }, [chatMode]);

  // Save include context preference to localStorage when it changes
  React.useEffect(() => {
    localStorage.setItem("AI_CHAT_INCLUDE_CONTEXT", String(includeContext));
  }, [includeContext]);

  useKeyDown("Escape", () => {
    if (showApiKeySettings) {
      setShowApiKeySettings(false);
    } else if (showModelPicker) {
      setShowModelPicker(false);
    } else {
      ui.set({ aiChatExpanded: false });
    }
  });

  // Close model picker when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      // For model picker, check both the dropdown and the button
      if (showModelPicker) {
        const isOutsideDropdown = modelPickerRef.current && !modelPickerRef.current.contains(target);
        const isOutsideButton = modelPickerButtonRef.current && !modelPickerButtonRef.current.contains(target);
        if (isOutsideDropdown && isOutsideButton) {
          setShowModelPicker(false);
        }
      }

      // For API key settings, check both the dropdown and the button
      if (showApiKeySettings) {
        const isOutsideDropdown = apiKeySettingsRef.current && !apiKeySettingsRef.current.contains(target);
        const isOutsideButton = apiKeyButtonRef.current && !apiKeyButtonRef.current.contains(target);
        if (isOutsideDropdown && isOutsideButton) {
          setShowApiKeySettings(false);
        }
      }
    };

    if (showModelPicker || showApiKeySettings) {
      // Use setTimeout to avoid the click that opened the dropdown from immediately closing it
      const timeoutId = setTimeout(() => {
        window.addEventListener("mousedown", handleClickOutside);
      }, 0);
      return () => {
        clearTimeout(timeoutId);
        window.removeEventListener("mousedown", handleClickOutside);
      };
    }
    return undefined;
  }, [showModelPicker, showApiKeySettings]);

  // Load available models on mount
  React.useEffect(() => {
    void aiChat.loadModels();
  }, [aiChat]);

  // Set current document ID for auto-apply
  React.useEffect(() => {
    if (document) {
      aiChat.setCurrentDocument(document.id);
    }
    return () => {
      aiChat.setCurrentDocument(null);
    };
  }, [document, aiChat]);

  // Set callback to get fresh document content for iterations
  React.useEffect(() => {
    if (document) {
      aiChat.setDocumentContentCallback(() => {
        const result = ProsemirrorHelper.toBlocksWithIds(document);
        return {
          context: result.content,
          blocks: result.blocks.map(b => ({
            blockId: b.blockId,
            index: b.index,
            content: b.content,
            type: b.type,
            editable: b.editable
          })),
        };
      });
    }
    return () => {
      aiChat.setDocumentContentCallback(null);
    };
  }, [document, aiChat]);

  // Detect compact mode when container is too small
  React.useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Switch to compact mode when width is less than 320px
        setIsCompact(entry.contentRect.width < 320);
      }
    });

    if (bottomRowRef.current) {
      observer.observe(bottomRowRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Auto-resize textarea based on content
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);

    // Reset height to auto to get the correct scrollHeight
    e.target.style.height = 'auto';
    // Set height to scrollHeight, capped at max-height
    const maxHeight = 120;
    e.target.style.height = Math.min(e.target.scrollHeight, maxHeight) + 'px';
  };
  // Get the last message content for auto-scroll dependency
  const lastMessage = aiChat.messages[aiChat.messages.length - 1];
  const lastMessageContent = lastMessage?.content;
  const lastMessageLoading = lastMessage?.isLoading;

  // Auto-scroll to bottom when new messages arrive or when AI is streaming response
  React.useEffect(() => {
    if (scrollableRef.current) {
      scrollableRef.current.scrollTo({
        top: scrollableRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [aiChat.messages.length, lastMessageContent, lastMessageLoading, aiChat.isStreaming]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || aiChat.isLoading || aiChat.isStreaming) {
      return;
    }

    // Check if the selected provider has an API key configured
    if (!aiChat.selectedProviderHasKey) {
      // Open the API key settings dropdown
      handleOpenApiKeySettings();
      return;
    }

    const message = inputValue.trim();
    setInputValue("");

    // In agent mode, always send full document content as context with block IDs
    // In ask mode, send context only if includeContext is enabled
    let documentContext: string | undefined;
    let blocks: Array<{ blockId: string; index: number; content: string; type: string; editable: boolean }> | undefined;

    if (document) {
      if (chatMode === "agent") {
        // Get document with persistent block IDs for precise AI editing
        const result = ProsemirrorHelper.toBlocksWithIds(document);
        documentContext = result.content;
        blocks = result.blocks.map(b => ({
          blockId: b.blockId,
          index: b.index,
          content: b.content,
          type: b.type,
          editable: b.editable
        }));
      } else if (chatMode === "ask" && includeContext) {
        // For ask mode, use regular markdown
        const markdown = ProsemirrorHelper.toMarkdown(document);
        documentContext = markdown;
      }
    }

    await aiChat.sendMessage(message, documentContext, chatMode, blocks);
  };

  // Handle continuing an iteration
  const handleContinue = React.useCallback(async () => {
    if (!aiChat.pendingContinuation || aiChat.isLoading || aiChat.isStreaming) {
      return;
    }
    await aiChat.continueIteration();
  }, [aiChat]);

  // Handle stopping the current stream
  const handleStop = React.useCallback(() => {
    aiChat.stopStreaming();
  }, [aiChat]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleClearChat = () => {
    aiChat.clearMessages();
  };

  const handleSelectModel = (providerId: string, modelId: string) => {
    aiChat.setProvider(providerId);
    aiChat.setModel(modelId);
    setShowModelPicker(false);
  };

  // Handle accepting an edit - apply it to the document via custom event
  const handleAcceptEdit = React.useCallback((messageId: string, edit: DocumentEdit) => {
    if (!document) return;

    // Dispatch a custom event that the editor can listen to
    // Uses persistent blockId for reliable targeting
    const event = new CustomEvent("ai-apply-edit", {
      detail: {
        documentId: document.id,
        edit: {
          blockId: edit.blockId,
          replaceWith: edit.replaceWith,
          action: edit.action,
          targetBlockId: edit.targetBlockId,
        },
      },
    });
    window.dispatchEvent(event);

    // Mark edit as accepted
    aiChat.updateEditStatus(messageId, edit.id, "accepted");
  }, [document, aiChat]);

  // Handle rejecting an edit
  const handleRejectEdit = React.useCallback((messageId: string, edit: DocumentEdit) => {
    aiChat.updateEditStatus(messageId, edit.id, "rejected");
  }, [aiChat]);

  // Handle accepting all pending edits
  // With persistent blockIds, order doesn't matter - each edit targets by ID not index
  const handleAcceptAllEdits = React.useCallback((messageId: string, edits: DocumentEdit[]) => {
    const pendingEdits = edits.filter(e => e.status === "pending");

    for (const edit of pendingEdits) {
      handleAcceptEdit(messageId, edit);
    }
  }, [handleAcceptEdit]);

  // Handle rejecting all pending edits  
  const handleRejectAllEdits = React.useCallback((messageId: string, edits: DocumentEdit[]) => {
    const pendingEdits = edits.filter(e => e.status === "pending");
    for (const edit of pendingEdits) {
      handleRejectEdit(messageId, edit);
    }
  }, [handleRejectEdit]);

  // Handle saving API keys
  const handleSaveApiKeys = React.useCallback(() => {
    for (const [providerId, key] of Object.entries(apiKeyInputs)) {
      if (key.trim()) {
        aiChat.setClientApiKey(providerId, key.trim());
      }
    }
    setApiKeyInputs({});
    setShowApiKeySettings(false);
  }, [apiKeyInputs, aiChat]);

  // Handle clearing API keys
  const handleClearApiKeys = React.useCallback(() => {
    aiChat.clearClientApiKeys();
    setApiKeyInputs({});
  }, [aiChat]);

  // Check if any API key input has value
  const hasApiKeyInput = React.useMemo(() => {
    return Object.values(apiKeyInputs).some(key => key.trim());
  }, [apiKeyInputs]);

  // Handle opening API key settings dropdown
  const handleOpenApiKeySettings = React.useCallback(() => {
    if (apiKeyButtonRef.current) {
      const rect = apiKeyButtonRef.current.getBoundingClientRect();
      setApiKeyDropdownPosition({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setShowApiKeySettings(true);
  }, []);

  // Handle opening model picker dropdown
  const handleOpenModelPicker = React.useCallback(() => {
    if (modelPickerButtonRef.current) {
      const rect = modelPickerButtonRef.current.getBoundingClientRect();
      setModelPickerPosition({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      });
    }
    setShowModelPicker(!showModelPicker);
  }, [showModelPicker]);

  // Get current model display name
  const currentModelName = React.useMemo(() => {
    const model = aiChat.availableModels.find(m => m.id === aiChat.selectedModel);
    return model?.name || aiChat.selectedModel || t("Select model");
  }, [aiChat.availableModels, aiChat.selectedModel, t]);

  const content = (
    <>
      <Scrollable
        id="ai-chat"
        bottomShadow
        hiddenScrollbars
        topShadow
        ref={scrollableRef}
      >
        <MessagesWrapper>
          {aiChat.messages.length > 0 ? (
            aiChat.messages.map((message, index) => {
              const prevMessage = index > 0 ? aiChat.messages[index - 1] : null;
              const isConsecutiveAi = message.role === "assistant" && prevMessage?.role === "assistant";

              return (
                <MessageContainer key={message.id} $isUser={message.role === "user"}>
                  <MessageAvatar $hidden={isConsecutiveAi}>
                    {message.role === "user" ? (
                      <Avatar model={user} size={24} />
                    ) : (
                      <AiAvatar $isStreaming={message.isStreaming}>
                        <SparklesIcon size={16} color={theme.white} />
                      </AiAvatar>
                    )}
                  </MessageAvatar>
                  <MessageBubble $isUser={message.role === "user"}>
                    {message.isLoading ? (
                      <LoadingDots>
                        <span />
                        <span />
                        <span />
                      </LoadingDots>
                    ) : message.role === "user" ? (
                      <MessageContent>{message.content}</MessageContent>
                    ) : (
                      <>
                        {/* Show summary badge for final summary messages */}
                        {message.isSummary && (
                          <SummaryBadge>
                            📋 {t("Summary")}
                          </SummaryBadge>
                        )}
                        {/* Streaming indicator */}
                        {message.isStreaming && (
                          <StreamingIndicator>
                            <StyledSpinner />
                            {t("Working...")}
                          </StreamingIndicator>
                        )}
                        <MarkdownContent
                          $isSummary={message.isSummary}
                          dangerouslySetInnerHTML={{
                            __html: md.render(message.content),
                          }}
                        />
                        {/* Continue button for iterative operations - only show if auto-apply is disabled */}
                        {message.hasMore && !message.isStreaming && !aiChat.autoApply && (
                          <ContinueContainer>
                            <ContinueButton onClick={handleContinue}>
                              <GoToIcon size={14} />
                              {t("Continue iteration")}
                            </ContinueButton>
                            <ContinueHint>
                              {t("More changes are needed. Click to continue.")}
                            </ContinueHint>
                          </ContinueContainer>
                        )}
                        {/* Render edits if any - Copilot style diff view */}
                        {message.edits && message.edits.length > 0 && (
                          <DiffSummaryContainer>
                            <DiffSummaryHeader
                              onClick={() => toggleDiffExpansion(message.id)}
                              $expanded={expandedDiffs.has(message.id)}
                            >
                              <DiffSummaryLeft>
                                <DiffSummaryIcon>
                                  <DocumentIcon size={16} />
                                </DiffSummaryIcon>
                                <DiffSummaryText>
                                  <DiffFileName>{t("Document changes")}</DiffFileName>
                                  <DiffStats>
                                    {(() => {
                                      const addLines = message.edits!.reduce((acc, e) =>
                                        acc + (e.replaceWith?.split('\n').length || 0), 0);
                                      const delLines = message.edits!.reduce((acc, e) =>
                                        acc + (e.originalContent?.split('\n').length || 0), 0);
                                      return (
                                        <>
                                          {addLines > 0 && <DiffAdditions>+{addLines}</DiffAdditions>}
                                          {delLines > 0 && <DiffDeletions>-{delLines}</DiffDeletions>}
                                          <DiffEditCount>({message.edits!.length} {message.edits!.length === 1 ? t("edit") : t("edits")})</DiffEditCount>
                                        </>
                                      );
                                    })()}
                                  </DiffStats>
                                </DiffSummaryText>
                              </DiffSummaryLeft>
                              <DiffExpandIcon $expanded={expandedDiffs.has(message.id)}>
                                <ArrowDownIcon size={16} />
                              </DiffExpandIcon>
                            </DiffSummaryHeader>

                            {expandedDiffs.has(message.id) && (
                              <DiffDetailsContainer>
                                {message.edits.map((edit) => (
                                  <DiffEditBlock key={edit.id}>
                                    <DiffEditHeader>
                                      <DiffEditAction $action={edit.action}>
                                        {edit.action === "delete" && "−"}
                                        {edit.action === "insertAfter" && "+"}
                                        {edit.action === "replace" && "±"}
                                        {edit.action === "moveAfter" && "↔"}
                                      </DiffEditAction>
                                      <DiffEditDescription>{edit.description}</DiffEditDescription>
                                      <DiffEditBlockId>@{edit.blockId.substring(0, 10)}</DiffEditBlockId>
                                    </DiffEditHeader>

                                    <DiffCodeBlock>
                                      {/* Show removed content */}
                                      {(edit.action === "delete" || edit.action === "replace") && edit.originalContent && (
                                        edit.originalContent.split('\n').map((line, i) => (
                                          <DiffLine key={`del-${i}`} $type="deletion">
                                            <DiffLineNumber>{i + 1}</DiffLineNumber>
                                            <DiffLineSign>−</DiffLineSign>
                                            <DiffLineContent>{line || ' '}</DiffLineContent>
                                          </DiffLine>
                                        ))
                                      )}
                                      {/* Show added content */}
                                      {(edit.action === "replace" || edit.action === "insertAfter") && edit.replaceWith && (
                                        edit.replaceWith.split('\n').map((line, i) => (
                                          <DiffLine key={`add-${i}`} $type="addition">
                                            <DiffLineNumber>{i + 1}</DiffLineNumber>
                                            <DiffLineSign>+</DiffLineSign>
                                            <DiffLineContent>{line || ' '}</DiffLineContent>
                                          </DiffLine>
                                        ))
                                      )}
                                    </DiffCodeBlock>
                                  </DiffEditBlock>
                                ))}

                                {/* Action buttons for manual mode */}
                                {!aiChat.autoApply && message.edits.some(e => e.status === "pending") && (
                                  <DiffActionsBar>
                                    <DiffActionButton
                                      $variant="accept"
                                      onClick={() => handleAcceptAllEdits(message.id, message.edits!)}
                                    >
                                      <CheckmarkIcon size={14} />
                                      {t("Accept All")}
                                    </DiffActionButton>
                                    <DiffActionButton
                                      $variant="reject"
                                      onClick={() => handleRejectAllEdits(message.id, message.edits!)}
                                    >
                                      <CloseIcon size={14} />
                                      {t("Reject All")}
                                    </DiffActionButton>
                                  </DiffActionsBar>
                                )}
                              </DiffDetailsContainer>
                            )}

                            {/* Status indicator */}
                            {aiChat.autoApply && (
                              <DiffAppliedBadge>
                                <CheckmarkIcon size={12} /> {t("Applied")}
                              </DiffAppliedBadge>
                            )}
                          </DiffSummaryContainer>
                        )}

                        {/* Document diff for final summary - like GitHub Copilot's file changes view */}
                        {message.isSummary && message.documentDiff && (
                          <DocumentDiffContainer>
                            <DocumentDiffHeader
                              onClick={() => toggleDiffExpansion(`doc-${message.id}`)}
                              $expanded={expandedDiffs.has(`doc-${message.id}`)}
                            >
                              <DiffSummaryLeft>
                                <DiffSummaryIcon>
                                  <DocumentIcon size={16} />
                                </DiffSummaryIcon>
                                <DiffSummaryText>
                                  <DiffFileName>{message.documentDiff.documentTitle}</DiffFileName>
                                  <DiffStats>
                                    {message.documentDiff.linesAdded > 0 && (
                                      <DiffAdditions>+{message.documentDiff.linesAdded}</DiffAdditions>
                                    )}
                                    {message.documentDiff.linesRemoved > 0 && (
                                      <DiffDeletions>-{message.documentDiff.linesRemoved}</DiffDeletions>
                                    )}
                                  </DiffStats>
                                </DiffSummaryText>
                              </DiffSummaryLeft>
                              <DiffExpandIcon $expanded={expandedDiffs.has(`doc-${message.id}`)}>
                                <ArrowDownIcon size={16} />
                              </DiffExpandIcon>
                            </DocumentDiffHeader>

                            {expandedDiffs.has(`doc-${message.id}`) && (
                              <DocumentDiffContent>
                                <DocumentDiffView
                                  original={message.documentDiff.originalContent}
                                  modified={message.documentDiff.finalContent}
                                />
                              </DocumentDiffContent>
                            )}
                          </DocumentDiffContainer>
                        )}
                      </>
                    )}
                  </MessageBubble>
                </MessageContainer>
              );
            })
          ) : (
            <EmptyState align="center" justify="center" auto>
              <EmptyContent>
                <SparklesIcon size={48} color={theme.textTertiary} />
                <EmptyTitle>{t("AI Assistant")}</EmptyTitle>
                <EmptyDescription>
                  {t("Ask questions about this document or get help with your writing.")}
                </EmptyDescription>
              </EmptyContent>
            </EmptyState>
          )}
        </MessagesWrapper>
      </Scrollable>

      <InputContainer onSubmit={handleSubmit}>
        {aiChat.error && (
          <ErrorContainer>
            <ErrorMessage>{aiChat.error}</ErrorMessage>
            <RetryButton
              type="button"
              onClick={() => aiChat.retry()}
              disabled={aiChat.isLoading}
            >
              <RestoreIcon size={14} />
              {t("Try again")}
            </RetryButton>
          </ErrorContainer>
        )}
        <StyledTextarea
          ref={inputRef}
          value={inputValue}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder={chatMode === "agent" ? t("Describe what you want the agent to do...") : t("Ask AI anything...")}
          disabled={aiChat.isLoading}
          rows={1}
        />
        <BottomRow ref={bottomRowRef}>
          <LeftControls>
            {/* Mode Toggle */}
            <ModeToggle>
              <ModeButton
                $active={chatMode === "ask"}
                onClick={() => setChatMode("ask")}
                type="button"
              >
                {t("Ask")}
              </ModeButton>
              <ModeButton
                $active={chatMode === "agent"}
                onClick={() => setChatMode("agent")}
                type="button"
              >
                {t("Agent")}
              </ModeButton>
            </ModeToggle>

            {/* Context Toggle (only in Ask mode) */}
            {chatMode === "ask" && document && (
              <Tooltip content={includeContext ? t("Document context enabled") : t("Add document as context")} placement="top">
                <ContextToggleButton
                  type="button"
                  $active={includeContext}
                  onClick={() => setIncludeContext(!includeContext)}
                >
                  <DocumentIcon size={16} />
                </ContextToggleButton>
              </Tooltip>
            )}

            {/* Model Picker */}
            {aiChat.providers.length > 0 && (
              <ModelPickerContainer>
                <Tooltip content={currentModelName} placement="top" delay={300}>
                  <ModelPickerButton
                    ref={modelPickerButtonRef}
                    type="button"
                    onClick={handleOpenModelPicker}
                    $compact={isCompact}
                  >
                    {isCompact ? (
                      <CloudIcon size={16} />
                    ) : (
                      <>
                        <span>{currentModelName}</span>
                        <DropdownArrow size={16} />
                      </>
                    )}
                  </ModelPickerButton>
                </Tooltip>
              </ModelPickerContainer>
            )}
          </LeftControls>

          {aiChat.isStreaming ? (
            <StopButton type="button" onClick={handleStop}>
              <CloseIcon size={14} />
              {t("Stop")}
            </StopButton>
          ) : (
            <ButtonSmall
              type="submit"
              disabled={!inputValue.trim() || aiChat.isLoading}
              borderOnHover
            >
              {aiChat.isLoading ? t("Thinking...") : t("Send")}
            </ButtonSmall>
          )}
        </BottomRow>
      </InputContainer>
    </>
  );

  return (
    <>
      <Sidebar
        title={
          <Flex align="center" justify="space-between" gap={8} auto>
            <TitleWrapper>
              <SparklesIcon size={20} />
              <span>{t("AI Chat")}</span>
            </TitleWrapper>
            <Flex align="center" gap={4}>
              {/* API Key Settings Button */}
              <Tooltip content={t("API Key Settings")} placement="bottom">
                <NudeButton
                  ref={apiKeyButtonRef}
                  onClick={handleOpenApiKeySettings}
                >
                  <SettingsIcon size={18} color={aiChat.hasClientApiKeys ? theme.accent : theme.textTertiary} />
                </NudeButton>
              </Tooltip>
              {aiChat.hasMessages && (
                <Tooltip content={t("Clear chat")} placement="bottom">
                  <NudeButton onClick={handleClearChat}>
                    <TrashIcon size={18} color={theme.textTertiary} />
                  </NudeButton>
                </Tooltip>
              )}
            </Flex>
          </Flex>
        }
        onClose={() => ui.set({ aiChatExpanded: false })}
        scrollable={false}
      >
        {content}
      </Sidebar>

      {/* API Key Settings Dropdown - rendered as Portal to escape overflow:hidden */}
      {showApiKeySettings && apiKeyDropdownPosition && ReactDOM.createPortal(
        <ApiKeySettingsDropdown
          ref={apiKeySettingsRef}
          style={{
            top: apiKeyDropdownPosition.top,
            right: apiKeyDropdownPosition.right
          }}
        >
          <ApiKeySettingsTitle>{t("API Keys")}</ApiKeySettingsTitle>
          <ApiKeyDescription>
            {aiChat.serverHasKeys
              ? t("Server has API keys configured. You can optionally use your own keys.")
              : t("No server API keys configured. Add your own keys to use AI features.")}
          </ApiKeyDescription>

          {aiChat.availableProviders.length > 0 ? (
            aiChat.availableProviders.map((provider) => (
              <ApiKeyInputGroup key={provider.id}>
                <ApiKeyLabel>{provider.name} API Key</ApiKeyLabel>
                <ApiKeyInput
                  type="password"
                  placeholder={aiChat.clientApiKeys[provider.id] ? "••••••••" : t("Enter API key...")}
                  value={apiKeyInputs[provider.id] || ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setApiKeyInputs(prev => ({ ...prev, [provider.id]: e.target.value }))
                  }
                />
                {aiChat.clientApiKeys[provider.id] && (
                  <ApiKeyStatus>{t("Configured")}</ApiKeyStatus>
                )}
              </ApiKeyInputGroup>
            ))
          ) : (
            <ApiKeyDescription>
              {t("Loading providers...")}
            </ApiKeyDescription>
          )}

          <ApiKeyActions>
            <ButtonSmall
              onClick={handleSaveApiKeys}
              disabled={!hasApiKeyInput}
            >
              {t("Save")}
            </ButtonSmall>
            {aiChat.hasClientApiKeys && (
              <ButtonSmall onClick={handleClearApiKeys} neutral>
                {t("Clear Keys")}
              </ButtonSmall>
            )}
          </ApiKeyActions>
        </ApiKeySettingsDropdown>,
        window.document.body
      )}

      {/* Model Picker Dropdown - rendered as Portal to escape overflow:hidden */}
      {showModelPicker && modelPickerPosition && ReactDOM.createPortal(
        <ModelPickerDropdown
          ref={modelPickerRef}
          style={{
            bottom: modelPickerPosition.bottom,
            left: modelPickerPosition.left,
          }}
        >
          {aiChat.providers.map((provider) => (
            <ProviderSection key={provider.id}>
              <ProviderName>{provider.name}</ProviderName>
              {provider.models.map((model) => (
                <ModelOption
                  key={model.id}
                  $selected={aiChat.selectedModel === model.id && aiChat.selectedProvider === provider.id}
                  onClick={() => handleSelectModel(provider.id, model.id)}
                >
                  <ModelName>{model.name}</ModelName>
                  {aiChat.selectedModel === model.id && aiChat.selectedProvider === provider.id && (
                    <SelectedIndicator>✓</SelectedIndicator>
                  )}
                </ModelOption>
              ))}
            </ProviderSection>
          ))}
        </ModelPickerDropdown>,
        window.document.body
      )}
    </>
  );
}

const TitleWrapper = styled(Flex)`
  align-items: center;
  gap: 8px;
`;

const MessagesWrapper = styled.div`
  padding: 12px;
  min-height: 100%;
`;

const EmptyState = styled(Flex)`
  height: 100%;
  min-height: 300px;
`;

const EmptyContent = styled.div`
  text-align: center;
  padding: 24px;
`;

const EmptyTitle = styled.h3`
  margin: 16px 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: ${s("text")};
`;

const EmptyDescription = styled.p`
  margin: 0;
  font-size: 14px;
  color: ${s("textTertiary")};
  max-width: 240px;
`;

const MessageContainer = styled.div<{ $isUser: boolean }>`
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-direction: ${(props) => (props.$isUser ? "row-reverse" : "row")};
`;

const MessageAvatar = styled.div<{ $hidden?: boolean }>`
  flex-shrink: 0;
  visibility: ${(props) => (props.$hidden ? "hidden" : "visible")};
  width: 24px;
`;

const pulseAnimation = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
`;

const AiAvatar = styled.div<{ $isStreaming?: boolean }>`
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  ${props => props.$isStreaming && css`
    animation: ${pulseAnimation} 1.5s ease-in-out infinite;
  `}
`;

const MessageBubble = styled.div<{ $isUser: boolean }>`
  max-width: 85%;
  padding: ${(props) => (props.$isUser ? "10px 14px" : "0")};
  border-radius: 16px;
  background: ${(props) =>
    props.$isUser ? props.theme.accent : "transparent"};
  color: ${(props) =>
    props.$isUser ? props.theme.white : props.theme.text};
  border-bottom-right-radius: ${(props) => (props.$isUser ? "4px" : "16px")};
  border-bottom-left-radius: ${(props) => (props.$isUser ? "16px" : "4px")};
`;

const MessageContent = styled.div`
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
`;

const MarkdownContent = styled.div<{ $isSummary?: boolean }>`
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  
  ${props => props.$isSummary && `
    background: linear-gradient(135deg, ${props.theme.accent}08, ${props.theme.accent}04);
    border: 1px solid ${props.theme.accent}30;
    border-radius: 8px;
    padding: 12px;
    margin-top: 4px;
  `}

  p {
    margin: 0 0 8px 0;
    &:last-child {
      margin-bottom: 0;
    }
  }

  strong {
    font-weight: 600;
  }

  em {
    font-style: italic;
  }

  code {
    background: ${s("codeBackground")};
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 13px;
  }

  pre {
    background: ${s("codeBackground")};
    padding: 12px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 8px 0;

    code {
      background: none;
      padding: 0;
    }
  }

  ul, ol {
    margin: 8px 0;
    padding-left: 20px;
  }

  li {
    margin: 4px 0;
  }

  a {
    color: ${s("accent")};
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }

  blockquote {
    border-left: 3px solid ${s("accent")};
    margin: 8px 0;
    padding-left: 12px;
    color: ${s("textSecondary")};
  }

  h1, h2, h3, h4, h5, h6 {
    margin: 12px 0 8px 0;
    font-weight: 600;
  }

  h1 { font-size: 1.3em; }
  h2 { font-size: 1.2em; }
  h3 { font-size: 1.1em; }
  
  hr {
    border: none;
    border-top: 1px solid ${s("divider")};
    margin: 12px 0;
  }
`;

const SummaryBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 3px 10px;
  border-radius: 12px;
  background: linear-gradient(135deg, ${(props) => props.theme.accent}20, ${(props) => props.theme.brand.green}20);
  color: ${s("accent")};
  margin-bottom: 8px;
  border: 1px solid ${(props) => props.theme.accent}30;
`;

const LoadingDots = styled.div`
  display: flex;
  gap: 4px;
  padding: 4px 0;

  span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${s("textTertiary")};
    animation: bounce 1.4s infinite ease-in-out both;

    &:nth-child(1) {
      animation-delay: -0.32s;
    }
    &:nth-child(2) {
      animation-delay: -0.16s;
    }
  }

  @keyframes bounce {
    0%, 80%, 100% {
      transform: scale(0);
    }
    40% {
      transform: scale(1);
    }
  }
`;

const InputContainer = styled.form`
  padding: 12px;
  border-top: 1px solid ${s("divider")};
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const ErrorContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: ${(props) => props.theme.danger}10;
  border-radius: 4px;
`;

const ErrorMessage = styled.div`
  color: ${s("danger")};
  font-size: 12px;
  flex: 1;
`;

const RetryButton = styled.button`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: ${s("danger")};
  color: white;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;

  &:hover {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const StyledTextarea = styled.textarea`
  width: 100%;
  min-height: 40px;
  max-height: 120px;
  padding: 10px 12px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  background: ${s("background")};
  color: ${s("text")};
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  transition: border-color 0.2s;

  &:focus {
    border-color: ${s("accent")};
  }

  &::placeholder {
    color: ${s("textTertiary")};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &:disabled {
    opacity: 0.6;
  }
`;

const BottomRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: nowrap;
`;

const LeftControls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
`;

const ModeToggle = styled.div`
  display: flex;
  background: ${s("sidebarBackground")};
  border-radius: 6px;
  padding: 2px;
`;

const ModeButton = styled.button<{ $active: boolean }>`
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  background: ${(props) => (props.$active ? props.theme.accent : "transparent")};
  color: ${(props) => (props.$active ? props.theme.white : props.theme.textTertiary)};

  &:hover {
    color: ${(props) => (props.$active ? props.theme.white : props.theme.text)};
  }
`;

const ContextToggleButton = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  background: ${(props) => (props.$active ? props.theme.accent + "20" : "transparent")};
  color: ${(props) => (props.$active ? props.theme.accent : props.theme.textTertiary)};

  &:hover {
    background: ${(props) => (props.$active ? props.theme.accent + "30" : props.theme.sidebarBackground)};
    color: ${(props) => (props.$active ? props.theme.accent : props.theme.text)};
  }
`;

const ModelPickerContainer = styled.div`
  position: relative;
  flex-shrink: 0;
`;

const ModelPickerButton = styled.button<{ $compact?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: ${(props) => props.$compact ? "4px 6px" : "4px 8px"};
  border: none;
  border-radius: 4px;
  background: transparent;
  color: ${s("textTertiary")};
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  max-width: ${(props) => props.$compact ? "32px" : "150px"};
  min-width: ${(props) => props.$compact ? "32px" : "auto"};

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover {
    background: ${s("sidebarBackground")};
    color: ${s("text")};
  }
`;

const ModelPickerDropdown = styled.div`
  position: fixed;
  min-width: 200px;
  max-width: 280px;
  max-height: 300px;
  overflow-y: auto;
  background: ${s("menuBackground")};
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 9999;
`;

const ProviderSection = styled.div`
  &:not(:last-child) {
    border-bottom: 1px solid ${s("divider")};
  }
`;

const ProviderName = styled.div`
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: ${s("textTertiary")};
  letter-spacing: 0.5px;
`;

const ModelOption = styled.div<{ $selected: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  background: ${(props) => (props.$selected ? props.theme.accent + "15" : "transparent")};
  transition: background 0.1s ease;

  &:hover {
    background: ${(props) => (props.$selected ? props.theme.accent + "20" : props.theme.sidebarBackground)};
  }
`;

const ModelName = styled.span`
  font-size: 13px;
  color: ${s("text")};
`;

const SelectedIndicator = styled.span`
  color: ${s("accent")};
  font-weight: 600;
`;

const DropdownArrow = styled(ArrowDownIcon)`
  flex-shrink: 0;
  opacity: 0.7;
`;

// Edit/Diff related styles
const EditsContainer = styled.div`
  margin-top: 12px;
  border-top: 1px solid ${s("divider")};
  padding-top: 12px;
`;

const EditsHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
`;

const EditsTitle = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${s("textSecondary")};
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const EditsActions = styled.div`
  display: flex;
  gap: 4px;
`;

const ActionButton = styled.button<{ $variant: "accept" | "reject" }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  background: ${(props) =>
    props.$variant === "accept"
      ? props.theme.brand.green + "20"
      : props.theme.danger + "20"};
  color: ${(props) =>
    props.$variant === "accept"
      ? props.theme.brand.green
      : props.theme.danger};

  &:hover {
    background: ${(props) =>
    props.$variant === "accept"
      ? props.theme.brand.green + "40"
      : props.theme.danger + "40"};
  }
`;

const EditCard = styled.div<{ $status: "pending" | "accepted" | "rejected" }>`
  background: ${s("background")};
  border: 1px solid ${(props) =>
    props.$status === "accepted"
      ? props.theme.brand.green + "50"
      : props.$status === "rejected"
        ? props.theme.danger + "50"
        : props.theme.inputBorder};
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 8px;
  opacity: ${(props) => props.$status !== "pending" ? 0.7 : 1};

  &:last-child {
    margin-bottom: 0;
  }
`;

const EditDescriptionFull = styled.div`
  font-size: 13px;
  color: ${s("text")};
  margin-bottom: 8px;
  line-height: 1.4;
`;

const EditHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`;

const EditAction = styled.span<{ $action: "replace" | "delete" | "insertAfter" | "moveAfter" }>`
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: ${(props) =>
    props.$action === "delete"
      ? props.theme.danger + "20"
      : props.$action === "insertAfter"
        ? props.theme.brand.green + "20"
        : props.$action === "moveAfter"
          ? props.theme.brand.purple + "20"
          : props.theme.accent + "20"};
  color: ${(props) =>
    props.$action === "delete"
      ? props.theme.danger
      : props.$action === "insertAfter"
        ? props.theme.brand.green
        : props.$action === "moveAfter"
          ? props.theme.brand.purple
          : props.theme.accent};
`;

const BlockIdBadge = styled.span`
  font-size: 9px;
  font-weight: 600;
  font-family: monospace;
  letter-spacing: 0.5px;
  padding: 2px 5px;
  border-radius: 4px;
  background: ${s("textTertiary")}20;
  color: ${s("textTertiary")};
  cursor: help;
`;

const DiffContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
`;

const DiffSection = styled.div<{ $type: "add" | "remove" }>`
  background: ${(props) =>
    props.$type === "add"
      ? props.theme.brand.green + "12"
      : props.theme.danger + "12"};
  border-left: 3px solid ${(props) =>
    props.$type === "add"
      ? props.theme.brand.green
      : props.theme.danger};
  border-radius: 4px;
  overflow: hidden;
`;

const DiffSectionHeader = styled.div`
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.1);
  color: ${s("textSecondary")};
`;

const DiffContent = styled.div`
  padding: 8px 12px;
  font-family: ${s("fontFamilyMono")};
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
`;

// Copilot-style diff view components
const DiffSummaryContainer = styled.div`
  margin-top: 12px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  overflow: hidden;
  background: ${s("background")};
`;

const DiffSummaryHeader = styled.div<{ $expanded: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  background: ${s("sidebarBackground")};
  transition: background 0.15s ease;
  
  &:hover {
    background: ${s("sidebarBackground")};
  }
`;

const DiffSummaryLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const DiffSummaryIcon = styled.div`
  color: ${s("textSecondary")};
  display: flex;
  align-items: center;
`;

const DiffSummaryText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const DiffFileName = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: ${s("text")};
`;

const DiffStats = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-family: ${s("fontFamilyMono")};
`;

const DiffAdditions = styled.span`
  color: ${(props) => props.theme.brand.green};
  font-weight: 600;
`;

const DiffDeletions = styled.span`
  color: ${(props) => props.theme.danger};
  font-weight: 600;
`;

const DiffEditCount = styled.span`
  color: ${s("textTertiary")};
  font-size: 11px;
`;

const DiffExpandIcon = styled.div<{ $expanded: boolean }>`
  color: ${s("textSecondary")};
  display: flex;
  align-items: center;
  transition: transform 0.2s ease;
  transform: rotate(${(props) => (props.$expanded ? "180deg" : "0deg")});
`;

const DiffDetailsContainer = styled.div`
  border-top: 1px solid ${s("inputBorder")};
`;

const DiffEditBlock = styled.div`
  border-bottom: 1px solid ${s("inputBorder")};
  
  &:last-child {
    border-bottom: none;
  }
`;

const DiffEditHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: ${s("sidebarBackground")};
  font-size: 12px;
`;

const DiffEditAction = styled.span<{ $action: "replace" | "delete" | "insertAfter" | "moveAfter" }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 14px;
  background: ${(props) =>
    props.$action === "delete"
      ? props.theme.danger + "20"
      : props.$action === "insertAfter"
        ? props.theme.brand.green + "20"
        : props.$action === "moveAfter"
          ? "#9333ea20"
          : props.theme.accent + "20"};
  color: ${(props) =>
    props.$action === "delete"
      ? props.theme.danger
      : props.$action === "insertAfter"
        ? props.theme.brand.green
        : props.$action === "moveAfter"
          ? "#9333ea"
          : props.theme.accent};
`;

const DiffEditDescription = styled.span`
  flex: 1;
  color: ${s("text")};
  font-weight: 500;
`;

const DiffEditBlockId = styled.span`
  font-family: ${s("fontFamilyMono")};
  font-size: 10px;
  color: ${s("textTertiary")};
  background: ${s("sidebarBackground")};
  padding: 2px 6px;
  border-radius: 4px;
`;

const DiffCodeBlock = styled.div`
  font-family: ${s("fontFamilyMono")};
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
`;

const DiffLine = styled.div<{ $type: "addition" | "deletion" | "context" }>`
  display: flex;
  align-items: stretch;
  background: ${(props) =>
    props.$type === "addition"
      ? props.theme.brand.green + "15"
      : props.$type === "deletion"
        ? props.theme.danger + "15"
        : "transparent"};
  
  &:hover {
    background: ${(props) =>
    props.$type === "addition"
      ? props.theme.brand.green + "25"
      : props.$type === "deletion"
        ? props.theme.danger + "25"
        : props.theme.sidebarBackground};
  }
`;

const DiffLineNumber = styled.span`
  width: 40px;
  padding: 0 8px;
  text-align: right;
  color: ${s("textTertiary")};
  font-size: 11px;
  user-select: none;
  background: rgba(0, 0, 0, 0.03);
  display: flex;
  align-items: center;
  justify-content: flex-end;
`;

const DiffLineSign = styled.span`
  width: 20px;
  text-align: center;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
`;

const DiffLineContent = styled.span`
  flex: 1;
  padding: 0 12px;
  white-space: pre-wrap;
  word-break: break-word;
`;

const DiffActionsBar = styled.div`
  display: flex;
  gap: 8px;
  padding: 12px;
  background: ${s("sidebarBackground")};
  border-top: 1px solid ${s("inputBorder")};
`;

const DiffActionButton = styled.button<{ $variant: "accept" | "reject" }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  background: ${(props) =>
    props.$variant === "accept"
      ? props.theme.brand.green
      : props.theme.danger};
  color: white;

  &:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }
  
  &:active {
    transform: translateY(0);
  }
`;

const DiffAppliedBadge = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 500;
  color: ${(props) => props.theme.brand.green};
  background: ${(props) => props.theme.brand.green}10;
  border-top: 1px solid ${s("inputBorder")};
`;

const EditActions = styled.div`
  display: flex;
  gap: 8px;
`;

const EditButton = styled.button<{ $variant: "accept" | "reject" }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  background: ${(props) =>
    props.$variant === "accept"
      ? props.theme.brand.green
      : props.theme.danger};
  color: white;

  &:hover {
    opacity: 0.9;
  }
`;

const EditStatus = styled.div<{ $status: "accepted" | "rejected" }>`
  font-size: 11px;
  font-weight: 500;
  color: ${(props) =>
    props.$status === "accepted"
      ? props.theme.brand.green
      : props.theme.danger};
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

// API Key Settings styles
const ApiKeySettingsContainer = styled.div`
  position: relative;
  display: flex;
  align-items: center;
`;

const ApiKeySettingsDropdown = styled.div`
  position: fixed;
  width: 300px;
  background: ${s("menuBackground")};
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 9999;
  padding: 16px;
`;

const ApiKeySettingsTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: ${s("text")};
  margin-bottom: 8px;
`;

const ApiKeyDescription = styled.div`
  font-size: 12px;
  color: ${s("textSecondary")};
  margin-bottom: 16px;
  line-height: 1.4;
`;

const ApiKeyInputGroup = styled.div`
  margin-bottom: 12px;
`;

const ApiKeyLabel = styled.label`
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: ${s("textSecondary")};
  margin-bottom: 4px;
`;

const ApiKeyInput = styled.input`
  width: 100%;
  padding: 8px 10px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 6px;
  background: ${s("background")};
  color: ${s("text")};
  font-size: 13px;
  font-family: monospace;
  outline: none;
  transition: border-color 0.2s;

  &:focus {
    border-color: ${s("accent")};
  }

  &::placeholder {
    color: ${s("textTertiary")};
  }
`;

const ApiKeyStatus = styled.div`
  font-size: 11px;
  color: ${s("accent")};
  margin-top: 4px;
`;

const ApiKeyActions = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 16px;
`;

// Streaming and iteration styles
const blinkAnimation = keyframes`
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0;
  }
`;

const StreamingIndicator = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: ${s("accent")};
  font-weight: 500;
`;

const StyledSpinner = styled(Spinner)`
  width: 12px;
  height: 12px;
  margin: 0;
`;

const StreamingCursor = styled.span`
  display: inline-block;
  width: 2px;
  height: 16px;
  background: ${s("accent")};
  margin-left: 2px;
  animation: ${blinkAnimation} 1s step-end infinite;
  vertical-align: middle;
`;

const IterationBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 10px;
  background: ${s("accent")}20;
  color: ${s("accent")};
  margin-bottom: 8px;
`;

const ContextSummarizedIndicator = styled.span`
  cursor: help;
  font-size: 12px;
`;

const ContinueContainer = styled.div`
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed ${s("divider")};
`;

const ContinueButton = styled.button`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: ${s("accent")};
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }
`;

const ContinueHint = styled.div`
  font-size: 11px;
  color: ${s("textTertiary")};
  margin-top: 6px;
`;

const StopButton = styled.button`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: ${s("danger")};
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    opacity: 0.9;
  }
`;

// Document Diff Components for Final Summary
const DocumentDiffContainer = styled.div`
  margin-top: 12px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid ${s("divider")};
  background: ${(props) => props.theme.sidebarBackground};
`;

const DocumentDiffHeader = styled.div<{ $expanded: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  background: ${(props) => props.$expanded ? props.theme.sidebarBackground : 'transparent'};
  transition: background 0.15s ease;

  &:hover {
    background: ${(props) => props.theme.sidebarBackground};
  }
`;

const DocumentDiffContent = styled.div`
  border-top: 1px solid ${s("divider")};
  max-height: 400px;
  overflow: auto;
`;

// Simple inline diff view component
const DocumentDiffView = ({ original, modified }: { original: string; modified: string }) => {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  // Create a simple unified diff view
  const diffLines: Array<{ type: 'context' | 'add' | 'remove' | 'header'; content: string; lineNum?: number }> = [];

  // Use a simple LCS-based approach to find differences
  const originalSet = new Set(originalLines.map((l, i) => ({ content: l.trim(), line: l, index: i })));
  const modifiedSet = new Set(modifiedLines.map((l, i) => ({ content: l.trim(), line: l, index: i })));

  // Simple comparison - show removed then added
  let oIdx = 0;
  let mIdx = 0;

  while (oIdx < originalLines.length || mIdx < modifiedLines.length) {
    const oLine = originalLines[oIdx];
    const mLine = modifiedLines[mIdx];

    if (oIdx >= originalLines.length) {
      // Only modified lines left - all additions
      diffLines.push({ type: 'add', content: mLine, lineNum: mIdx + 1 });
      mIdx++;
    } else if (mIdx >= modifiedLines.length) {
      // Only original lines left - all removals
      diffLines.push({ type: 'remove', content: oLine, lineNum: oIdx + 1 });
      oIdx++;
    } else if (oLine.trim() === mLine.trim()) {
      // Same line
      diffLines.push({ type: 'context', content: oLine, lineNum: oIdx + 1 });
      oIdx++;
      mIdx++;
    } else {
      // Check if the original line appears later in modified
      const oInModified = modifiedLines.slice(mIdx + 1).findIndex(l => l.trim() === oLine.trim());
      const mInOriginal = originalLines.slice(oIdx + 1).findIndex(l => l.trim() === mLine.trim());

      if (mInOriginal !== -1 && (oInModified === -1 || mInOriginal <= oInModified)) {
        // Original line was removed
        diffLines.push({ type: 'remove', content: oLine, lineNum: oIdx + 1 });
        oIdx++;
      } else {
        // Modified line was added
        diffLines.push({ type: 'add', content: mLine, lineNum: mIdx + 1 });
        mIdx++;
      }
    }
  }

  // Limit displayed lines for performance
  const displayLines = diffLines.slice(0, 200);
  const hasMore = diffLines.length > 200;

  return (
    <DiffViewContainer>
      {displayLines.map((line, idx) => (
        <DocumentDiffLine key={idx} $type={line.type}>
          <DocumentDiffLineNumber>{line.lineNum || ''}</DocumentDiffLineNumber>
          <DocumentDiffLineSign>
            {line.type === 'add' && '+'}
            {line.type === 'remove' && '−'}
            {line.type === 'context' && ' '}
          </DocumentDiffLineSign>
          <DocumentDiffLineContent>{line.content || ' '}</DocumentDiffLineContent>
        </DocumentDiffLine>
      ))}
      {hasMore && (
        <DiffMoreIndicator>
          ... {diffLines.length - 200} more lines
        </DiffMoreIndicator>
      )}
    </DiffViewContainer>
  );
};

const DiffViewContainer = styled.div`
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
`;

const DocumentDiffLine = styled.div<{ $type: 'context' | 'add' | 'remove' | 'header' }>`
  display: flex;
  align-items: stretch;
  min-height: 20px;
  background: ${(props) => {
    switch (props.$type) {
      case 'add':
        return '#22863a15';
      case 'remove':
        return '#cb253715';
      default:
        return 'transparent';
    }
  }};
  
  &:hover {
    background: ${(props) => {
    switch (props.$type) {
      case 'add':
        return '#22863a25';
      case 'remove':
        return '#cb253725';
      default:
        return props.theme.sidebarBackground;
    }
  }};
  }
`;

const DocumentDiffLineNumber = styled.span`
  width: 40px;
  padding: 0 8px;
  text-align: right;
  color: ${s("textTertiary")};
  user-select: none;
  flex-shrink: 0;
`;

const DocumentDiffLineSign = styled.span`
  width: 20px;
  text-align: center;
  font-weight: 600;
  color: inherit;
  user-select: none;
  flex-shrink: 0;
`;

const DocumentDiffLineContent = styled.span`
  flex: 1;
  padding-right: 8px;
  white-space: pre-wrap;
  word-break: break-word;
`;

const DiffMoreIndicator = styled.div`
  padding: 8px 16px;
  text-align: center;
  color: ${s("textTertiary")};
  font-style: italic;
  background: ${s("sidebarBackground")};
`;

export default observer(AiChat);
