import Router from "koa-router";
import { PassThrough } from "stream";
import env from "@server/env";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import fetch from "node-fetch";
import * as T from "./schema";

const router = new Router();

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
    };
    finish_reason?: string;
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content?: {
      parts?: Array<{
        text: string;
      }>;
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }>;
}

// Provider configuration with models, display names and server env keys
const PROVIDERS: Record<string, {
  name: string;
  envKey: keyof typeof env;
  defaultModel: string;
  models: Array<{ id: string; name: string }>;
}> = {
  openai: {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-3.5-turbo",
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { id: "gpt-4", name: "GPT-4" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
    ],
  },
  gemini: {
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite" },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    ],
  },
};

// Helper to get API key for a provider (server or client)
function getApiKeyForProvider(providerId: string, clientApiKey?: string): string | undefined {
  const config = PROVIDERS[providerId];
  if (!config) return undefined;
  return (env[config.envKey] as string | undefined) || clientApiKey;
}

async function callOpenAI(
  messages: Array<{ role: string; content: string }>,
  model: string,
  jsonMode = false,
  apiKey?: string
): Promise<string> {
  const key = apiKey || env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OpenAI API key not configured");
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 20000,
      temperature: 0.7,
      ...(jsonMode && { response_format: { type: "json_object" } }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[OpenAI] API error:", error);

    // Parse common error types
    try {
      const errorData = JSON.parse(error);
      if (errorData.error?.code === "context_length_exceeded") {
        throw new Error("The document is too long. Try selecting a smaller portion.");
      }
      if (errorData.error?.code === "rate_limit_exceeded") {
        throw new Error("Rate limit reached. Please wait a moment and try again.");
      }
      if (errorData.error?.type === "insufficient_quota") {
        throw new Error("API quota exceeded. Please check your API key.");
      }
    } catch (e) {
      // If parsing fails, use generic message
    }

    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenAIResponse;

  if (!data.choices || data.choices.length === 0) {
    throw new Error("The AI couldn't generate a response. Please try again.");
  }

  return data.choices[0]?.message?.content || "I couldn't generate a response.";
}

async function callGemini(
  messages: Array<{ role: string; content: string }>,
  model: string,
  jsonMode = false,
  apiKey?: string
): Promise<string> {
  const key = apiKey || env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini API key not configured");
  }
  // Convert messages to Gemini format
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  // Add system instruction if present
  const systemMessage = messages.find((m) => m.role === "system");

  console.log("[Gemini] Sending request to API...");
  const startTime = Date.now();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents,
        systemInstruction: systemMessage
          ? { parts: [{ text: systemMessage.content }] }
          : undefined,
        generationConfig: {
          maxOutputTokens: 20000, // Reduced to avoid long waits
          temperature: 0.7,
          ...(jsonMode && { responseMimeType: "application/json" }),
        },
      }),
    }
  );

  console.log("[Gemini] Response received in", Date.now() - startTime, "ms");

  if (!response.ok) {
    const error = await response.text();
    console.error("[Gemini] API error:", error);
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as GeminiResponse;

  // Check if we have valid candidates
  if (!data.candidates || data.candidates.length === 0) {
    console.error("[Gemini] No candidates in response:", JSON.stringify(data));
    throw new Error("The AI couldn't generate a response. Please try again.");
  }

  const candidate = data.candidates[0];

  // Check for finish reasons that indicate problems
  if (candidate.finishReason) {
    const reason = candidate.finishReason;
    if (reason === "MAX_TOKENS") {
      console.warn("[Gemini] Response truncated due to max tokens");
      // Try to return partial content if available
      if (candidate.content?.parts?.[0]?.text) {
        return candidate.content.parts[0].text;
      }
      throw new Error("The response was too long and got cut off. Try asking for a shorter response.");
    }
    if (reason === "SAFETY") {
      throw new Error("The request was blocked for safety reasons. Please rephrase your question.");
    }
    if (reason === "RECITATION") {
      throw new Error("The request was blocked due to content policy. Please rephrase your question.");
    }
  }

  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    console.error("[Gemini] Invalid candidate structure:", JSON.stringify(candidate));
    throw new Error("The AI returned an empty response. Please try again.");
  }

  return candidate.content.parts[0]?.text || "I couldn't generate a response.";
}

// Streaming function for OpenAI
async function* streamOpenAI(
  messages: Array<{ role: string; content: string }>,
  model: string,
  apiKey?: string
): AsyncGenerator<string, void, unknown> {
  const key = apiKey || env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OpenAI API key not configured");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4000, // Reduced for iterative approach
      temperature: 0.7,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[OpenAI Stream] API error:", error);
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as AsyncIterable<Buffer>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const data = JSON.parse(trimmed.slice(6)) as OpenAIStreamChunk;
        const content = data.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      } catch {
        // Skip invalid JSON
      }
    }
  }
}

// Streaming function for Gemini
async function* streamGemini(
  messages: Array<{ role: string; content: string }>,
  model: string,
  apiKey?: string
): AsyncGenerator<string, void, unknown> {
  const key = apiKey || env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini API key not configured");
  }

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const systemMessage = messages.find((m) => m.role === "system");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents,
        systemInstruction: systemMessage
          ? { parts: [{ text: systemMessage.content }] }
          : undefined,
        generationConfig: {
          maxOutputTokens: 4000, // Reduced for iterative approach
          temperature: 0.7,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("[Gemini Stream] API error:", error);
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as AsyncIterable<Buffer>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      try {
        const data = JSON.parse(trimmed.slice(6)) as GeminiResponse;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          yield text;
        }
      } catch {
        // Skip invalid JSON
      }
    }
  }
}

// Build the iterative agent system prompt
function buildIterativeAgentPrompt(
  documentContext?: string,
  continueFrom?: string,
  maxEdits = 12,
  iterationCount = 1,
  contextSummary?: string
): string {
  let systemPrompt = `<identity>
You are an expert AI document editing agent for Outline, a collaborative rich-text editor.
You EXECUTE edits - you don't just describe what you would do.
</identity>

<critical_behavior>
⚠️ YOU MUST ACTUALLY MAKE EDITS - NOT JUST DESCRIBE THEM
- WRONG: "I will add a section about X" → This does NOTHING
- CORRECT: Include actual edit objects in the "edits" array

⚠️ NEVER SAY "DONE" WITHOUT CHECKING:
- Empty edits array + "done" = You didn't do anything!
- Before saying complete, verify your edits array contains the changes
- If user asks to reorganize/rewrite → you MUST have edits in the array
</critical_behavior>

<core_principles>
1. ACTION OVER DESCRIPTION: Generate edits, don't describe what you would do
2. ATOMIC PRECISION: One logical change per edit, max ${maxEdits} edits per iteration
3. VERIFY BEFORE ACTING: Check document state before editing
4. NO DUPLICATES: Scan the document before inserting content
5. USER LANGUAGE: Respond in the user's language
</core_principles>

<response_format>
Respond with ONLY valid JSON, no markdown code blocks:

{
  "response": "Brief summary of changes ACTUALLY MADE (not planned)",
  "edits": [...],  // ⚠️ MUST contain actual edits if work was requested
  "hasMore": boolean,
  "verification": boolean
}

⚠️ VALIDATION CHECK before responding:
- User asked for changes? → edits array MUST NOT be empty
- edits is empty? → You're probably just describing, not doing
- Set "hasMore": true if ANY work remains
</response_format>

<edit_schema>
{
  "blockId": "blk_xxx",           // EXACT ID from document (no prefixes)
  "action": "replace|delete|insertAfter",
  "replaceWith": "new content",   // Not needed for delete
  "description": "Brief description in user's language"
}

⚠️ CRITICAL RULES:
- blockId: Use ONLY the ID part (e.g., "blk_mipvyt33kzo9qn")
- NEVER include prefixes like "ID:", "LIST:", or "ITEM:" in blockId
- Extract just the blk_xxx portion from markers
</edit_schema>

<document_structure>
Block markers in document:
- [ID:blk_xxx] content → blockId: "blk_xxx"
- [LIST:blk_xxx] (type with N items) → blockId: "blk_xxx"
- [ITEM:blk_xxx_item0] → blockId: "blk_xxx_item0"
- [NON-EDITABLE:type] → Can only be deleted or moved

Available block types:
- Text: paragraph, heading (# ## ### ####)
- Lists: bullet_list, ordered_list, checkbox_list
- Code: code_fence (\`\`\`lang), math_block ($$)
- Navigation: table_of_contents (use [[toc]] to insert)
- Other: blockquote (>), hr (---), table, image
</document_structure>

<workflow>
BEFORE each edit:
1. "Does this content already exist?" → Skip if yes
2. "Is this the correct blockId?" → Verify in document
3. "Will this preserve document integrity?" → Be careful with deletions

EACH iteration:
1. Audit current document state
2. Plan up to ${maxEdits} atomic edits
3. EXECUTE edits (put them in the edits array!)
4. Set hasMore: true if work remains

⚠️ SELF-CHECK before sending response:
- Did user ask for document changes? YES
- Is my edits array empty? → WRONG! Go back and add actual edits
- Am I describing future work? → WRONG! Do the work NOW

FINAL verification (when you believe task is complete):
{
  "response": "Vérification: [requested vs completed]",
  "edits": [...fixes if any...],
  "hasMore": false,
  "verification": true
}
</workflow>

<quality_standards>
- ACTION: If user requests changes, your edits array MUST contain edits
- CONCISE: No preamble ("I will..."), no postamble ("Let me know...")
- PRECISE: Use exact blockIds, no guessing
- THOROUGH: Complete the full request, don't stop early
- MARKDOWN: Always use proper markdown formatting:
  * Headings: # (h1), ## (h2), ### (h3), #### (h4) - don't forget them!
  * Emphasis: **bold**, *italic*
  * Code: \`inline\` or \`\`\`blocks\`\`\`
- LISTS: Keep list formatting clean:
  * Use ONLY numbers (1. 2. 3.) OR bullets (- or *) - never mix in same level
  * WRONG: "3. a. text" or "1. - item" → broken formatting
  * For sub-items: use nested lists, not "a. b. c." inline
  * Each list item = ONE prefix only (either "1." or "-", not both)
- NEVER describe future actions - DO them now with actual edits
</quality_standards>`;

  // If we have a context summary, include it to reduce cognitive load
  if (contextSummary) {
    systemPrompt += `

=== CONTEXT SUMMARY (from previous iterations) ===
${contextSummary}
===

⚠️ CRITICAL: The above summary contains the ORIGINAL USER REQUEST and REMAINING WORK.
- You MUST complete ALL remaining tasks from the original request
- Do NOT say "done" unless the original request is FULLY satisfied
- If you say "next step will be X" → WRONG! Do X now with actual edits
- Check the document below to see what still needs to be done
- Set hasMore: true if ANY work from the original request remains`;
  }

  if (continueFrom) {
    systemPrompt += `

=== ITERATION ${iterationCount} ===
🔄 CONTINUING WORK - Document has been UPDATED with your previous edits.

⚠️ IMPORTANT: Block IDs may have CHANGED since your last response!
- ALWAYS check the CURRENT DOCUMENT below for valid block IDs
- The IDs you used before may no longer exist
- Use ONLY the IDs you see in the document RIGHT NOW

STEP 1: AUDIT the document below
- Note the CURRENT block IDs (they start with blk_)
- List sections/content that NOW EXIST (your previous work)
- List what STILL NEEDS to be done
- Check for any DUPLICATES to remove

STEP 2: PLAN next ${maxEdits} atomic edits
- Use ONLY block IDs from the CURRENT document
- Only work on content that DOESN'T EXIST yet
- If you see a heading/section you were about to add → IT'S DONE, skip it

STEP 3: EXECUTE with precision
- Double-check each blockId before editing
- Use "delete" if you spot duplicates

⚠️ DUPLICATE PREVENTION:
Before ANY insertAfter, search the document for:
- Same heading text
- Similar paragraph content
- Related section names
If found → DO NOT INSERT, move to next task`;
  }

  if (documentContext) {
    systemPrompt += `

CURRENT DOCUMENT:
---
${documentContext.substring(0, 35000)}
---`;
  }

  return systemPrompt;
}

router.post(
  "ai.chat",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(T.AiChatSchema),
  async (ctx: APIContext<T.AiChatReq>) => {
    // Extend timeout for AI requests as they can take significantly longer than the default 10 seconds
    if (ctx.req.socket) {
      ctx.req.socket.setTimeout(3 * 60 * 1000); // 3 minutes
    }

    const { message, documentContext, history, provider, model, mode, clientApiKey } = ctx.input.body;

    console.log("[AI Chat] Request received, documentContext length:", documentContext?.length || 0);

    // Determine which provider to use and get API key
    const availableProviders = Object.keys(PROVIDERS).filter(pid => {
      const key = getApiKeyForProvider(pid, pid === provider ? clientApiKey : undefined);
      return !!key;
    });

    const selectedProvider = provider && availableProviders.includes(provider)
      ? provider
      : availableProviders[0] || null;

    // Get the API key for the selected provider
    const activeApiKey = selectedProvider
      ? getApiKeyForProvider(selectedProvider, clientApiKey)
      : undefined;

    // Determine which model to use
    let selectedModel = model;
    if (!selectedModel) {
      if (selectedProvider === "openai") {
        selectedModel = env.OPENAI_MODEL || "gpt-3.5-turbo";
      } else {
        selectedModel = env.GEMINI_MODEL || "gemini-2.5-flash";
      }
    }

    // Build the messages array for the API
    const messages: Array<{ role: string; content: string }> = [];

    // Add system message with context based on mode
    let systemPrompt: string;
    let requestEdits = false;

    if (mode === "agent") {
      requestEdits = true;
      systemPrompt = `<identity>
You are an expert AI document editing agent for Outline, a collaborative rich-text editor.
You EXECUTE document edits - you don't just describe what you would do.
Respond ONLY with valid JSON - no markdown code blocks.
</identity>

<critical_behavior>
⚠️ YOU MUST ACTUALLY MAKE EDITS - NOT DESCRIBE THEM
- WRONG: "I will reorganize the document" with empty edits → Does nothing!
- CORRECT: Include actual edit objects in the "edits" array
- If user asks for changes → edits array MUST contain edits
</critical_behavior>

<response_format>
{"response": "brief summary of changes MADE", "edits": [...]}
Only if truly no edits needed: {"response": "answer", "edits": []}
⚠️ Empty edits when user asked for changes = FAILURE
</response_format>

<edit_schema>
{
  "blockId": "blk_xxx",              // EXACT ID from document markers
  "action": "replace|delete|insertAfter|moveAfter",
  "replaceWith": "markdown content", // Not needed for delete
  "targetBlockId": "blk_yyy",        // Only for moveAfter
  "description": "what this edit does"
}
</edit_schema>

<document_structure>
Block markers:
- [ID:blk_xxx] content → blockId: "blk_xxx"
- [LIST:blk_xxx] (type with N items) → target list or use item IDs
- [ITEM:blk_xxx_item0] → blockId: "blk_xxx_item0"
- [NON-EDITABLE:type] → Can ONLY delete or moveAfter
</document_structure>

<block_types>
TEXT:
- paragraph: Plain text
- heading: # (h1), ## (h2), ### (h3), #### (h4)
- blockquote: > Quote text

LISTS (target items individually):
- bullet_list / ordered_list / checkbox_list
- Checkbox items: [ ] unchecked, [x] checked
- When replacing items: text only, no prefix

CODE & MATH:
- code_fence: \`\`\`language\\ncode\\n\`\`\`
- math_block: $$\\nLaTeX\\n$$

NOTICES (:::style ... :::):
- info, warning, success, tip

NAVIGATION:
- table_of_contents: [[toc]] (auto-generated from headings)

OTHER:
- hr: --- (divider) or *** (page break)
- table: | Col1 | Col2 |\\n|---|---|\\n| A | B |
- image: ![alt](url) or ![alt](url "=WxH")
</block_types>

<actions>
- replace: Change block content (use exact markdown)
- delete: Remove block entirely
- insertAfter: Add new block after this one
- moveAfter: Move block to new position (use targetBlockId)
</actions>

<critical_rules>
1. ACTION REQUIRED: User asks for changes → you MUST provide edits
2. Use EXACT blockId from markers - strip prefixes (ID:, LIST:, ITEM:)
3. List items are individual - target specific [ITEM:] IDs
4. Images: Keep all on ONE line, preserve "=WxH" dimensions
5. Non-editable blocks: Only delete or move
6. Match user's language in response and description
</critical_rules>

<examples>
Insert code block:
{"blockId": "blk_xyz", "action": "insertAfter", "replaceWith": "\`\`\`python\\nprint('hello')\\n\`\`\`", "description": "Add Python code"}

Create warning:
{"blockId": "blk_xyz", "action": "insertAfter", "replaceWith": ":::warning\\nBe careful!\\n:::", "description": "Add warning"}

Update list item:
{"blockId": "blk_abc_item1", "action": "replace", "replaceWith": "Fixed text", "description": "Fix typo"}

Move video:
{"blockId": "blk_video", "action": "moveAfter", "targetBlockId": "blk_para", "description": "Move after paragraph"}
</examples>

<quality_standards>
- ACTION: User asks for changes → edits array MUST have edits
- CONCISE: Brief response, no "I will..." or "Let me know..."
- PRECISE: Exact blockIds, proper markdown syntax
- COMPLETE: Address full user request in one response
- MARKDOWN: Always use proper markdown formatting:
  * Headings: # (h1), ## (h2), ### (h3), #### (h4) - don't forget them!
  * Emphasis: **bold**, *italic*
- LISTS: Keep list formatting clean:
  * Use ONLY numbers (1. 2. 3.) OR bullets (-) - never mix in same level
  * WRONG: "3. a. text" or "1. - item" → broken formatting
  * For sub-items: use nested lists, not "a. b. c." inline
  * Each list item = ONE prefix only
- NEVER describe future work - DO the work now with actual edits
</quality_standards>`;

      if (documentContext) {
        systemPrompt += `

DOCUMENT (with block IDs):
---
${documentContext.substring(0, 30000)}
---`;
      } else {
        systemPrompt += `

NOTE: No document content was provided. Ask the user to ensure they have a document open.`;
      }
    } else {
      systemPrompt = `<identity>
You are a knowledgeable AI assistant integrated into Outline, a collaborative document editor.
</identity>

<capabilities>
- Answer questions about documents and their content
- Help with writing, editing, and structuring text
- Provide explanations, summaries, and suggestions
- Assist with formatting and markdown
</capabilities>

<communication_style>
- Be CONCISE: Get to the point, avoid filler phrases
- Be HELPFUL: Provide actionable, useful information
- Be CLEAR: Use simple language, structure with markdown
- MATCH user's language: Respond in the same language as the user
</communication_style>

<formatting>
- Use markdown for structure: **bold**, *italic*, \`code\`, lists
- Use headers sparingly (## and ### only when helpful)
- Keep paragraphs short and focused
- Use bullet points for lists of items
</formatting>

<guidelines>
- NO preamble ("Here's what I found...", "I'd be happy to...")
- NO postamble ("Let me know if you need more...", "Hope this helps!")
- Answer questions directly
- Provide examples when they add clarity
- If unsure, say so briefly rather than guessing
</guidelines>`;

      if (documentContext) {
        systemPrompt += `\n\nThe user is currently working on a document titled: "${documentContext}"`;
      }
    }

    messages.push({
      role: "system",
      content: systemPrompt,
    });

    // Add conversation history
    if (history && history.length > 0) {
      for (const msg of history.slice(-10)) {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    // Add the current user message
    messages.push({
      role: "user",
      content: message,
    });

    try {
      // Check for API keys
      const hasProvider = !!selectedProvider && !!activeApiKey;

      console.log("[AI Chat] Provider requested:", provider, "| Selected:", selectedProvider);
      console.log("[AI Chat] Model:", selectedModel);
      console.log("[AI Chat] Has active provider:", hasProvider);
      console.log("[AI Chat] Using client API key:", !!clientApiKey);

      if (!hasProvider) {
        ctx.body = {
          data: {
            response: `No AI provider configured. You can either:

1. **Use your own API key**: Click the ⚙️ icon in the chat to add your OpenAI or Gemini API key.

2. **Server configuration**: Ask your administrator to set one of these environment variables:
   - OPENAI_API_KEY for OpenAI/ChatGPT
   - GEMINI_API_KEY for Google Gemini

Once configured, I'll be able to:
- Answer questions about your documents
- Help with writing and editing
- Provide suggestions and explanations
- Assist with formatting and structure`,
          },
        };
        return;
      }

      let aiResponse: string;

      if (selectedProvider === "gemini") {
        aiResponse = await callGemini(messages, selectedModel, requestEdits, activeApiKey);
      } else if (selectedProvider === "openai") {
        aiResponse = await callOpenAI(messages, selectedModel, requestEdits, activeApiKey);
      } else {
        throw new Error("No valid AI provider available");
      }

      // Parse response for agent mode (edits)
      if (requestEdits) {
        try {
          // Clean up the response - remove markdown code blocks if present
          let cleanedResponse = aiResponse.trim();

          // Remove markdown code block markers
          if (cleanedResponse.startsWith("```json")) {
            cleanedResponse = cleanedResponse.slice(7);
          } else if (cleanedResponse.startsWith("```")) {
            cleanedResponse = cleanedResponse.slice(3);
          }
          if (cleanedResponse.endsWith("```")) {
            cleanedResponse = cleanedResponse.slice(0, -3);
          }
          cleanedResponse = cleanedResponse.trim();

          // Try to extract JSON if the response contains other text
          const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            cleanedResponse = jsonMatch[0];
          }

          // Fix common JSON escape issues from AI responses containing LaTeX or special chars
          // The AI often generates invalid escape sequences like \f (from \frac), \a, \p, etc.
          const fixJsonEscapes = (jsonStr: string): string => {
            // Strategy: Process character by character, fixing invalid escapes in strings
            let result = '';
            let inString = false;
            let i = 0;

            while (i < jsonStr.length) {
              const char = jsonStr[i];

              if (char === '"' && (i === 0 || jsonStr[i - 1] !== '\\')) {
                inString = !inString;
                result += char;
                i++;
                continue;
              }

              if (char === '\\' && inString && i + 1 < jsonStr.length) {
                const nextChar = jsonStr[i + 1];
                // Valid JSON escape sequences: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX
                const validEscapes = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'];

                if (validEscapes.includes(nextChar)) {
                  // Valid escape sequence - keep as is
                  result += char + nextChar;
                  i += 2;

                  // For \u, also include the 4 hex digits
                  if (nextChar === 'u' && i + 4 <= jsonStr.length) {
                    result += jsonStr.substring(i, i + 4);
                    i += 4;
                  }
                } else {
                  // Invalid escape - escape the backslash itself
                  result += '\\\\' + nextChar;
                  i += 2;
                }
                continue;
              }

              result += char;
              i++;
            }

            return result;
          };

          // Extract edit objects from a potentially malformed edits array string
          const extractEditObjects = (editsArrayContent: string): string[] => {
            const objects: string[] = [];
            let depth = 0;
            let start = -1;
            let inString = false;

            for (let i = 0; i < editsArrayContent.length; i++) {
              const char = editsArrayContent[i];
              const prevChar = i > 0 ? editsArrayContent[i - 1] : '';

              // Track string boundaries (accounting for escaped quotes)
              if (char === '"' && prevChar !== '\\') {
                inString = !inString;
                continue;
              }

              if (inString) continue;

              if (char === '{') {
                if (depth === 0) {
                  start = i;
                }
                depth++;
              } else if (char === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                  objects.push(editsArrayContent.substring(start, i + 1));
                  start = -1;
                }
              }
            }

            return objects;
          };

          // Try parsing, if it fails, try fixing escapes
          let parsed;
          try {
            parsed = JSON.parse(cleanedResponse);
          } catch (firstError) {
            console.log("[AI Chat] First parse failed, attempting to fix JSON escapes...");
            try {
              const fixedJson = fixJsonEscapes(cleanedResponse);
              parsed = JSON.parse(fixedJson);
              console.log("[AI Chat] Fixed JSON parse succeeded");
            } catch (secondError) {
              // Try a more aggressive fix: replace problematic LaTeX in string values
              console.log("[AI Chat] Second parse failed, trying aggressive cleanup...");

              // Extract response and edits separately using regex
              const responseMatch = cleanedResponse.match(/"response"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
              const editsMatch = cleanedResponse.match(/"edits"\s*:\s*\[([\s\S]*)\]/);

              if (responseMatch) {
                // Build a minimal valid response
                const extractedResponse = responseMatch[1]
                  .replace(/\\(?![nrtbf"\\\/u])/g, '\\\\'); // Fix invalid escapes

                parsed = {
                  response: extractedResponse.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
                  edits: [] as Array<{ type: string; oldContent?: string; newContent?: string; description?: string }>
                };

                // Try to parse individual edits
                if (editsMatch) {
                  try {
                    // Try to extract edit objects one by one (handles nested braces)
                    const editsContent = editsMatch[1];
                    const editObjects = extractEditObjects(editsContent);

                    for (const editStr of editObjects) {
                      try {
                        const fixedEditStr = fixJsonEscapes(editStr);
                        const edit = JSON.parse(fixedEditStr);
                        if (edit && edit.type) {
                          // Clean up the oldContent/newContent - decode escape sequences
                          if (edit.oldContent) {
                            edit.oldContent = edit.oldContent
                              .replace(/\\n/g, '\n')
                              .replace(/\\t/g, '\t')
                              .replace(/\\\\/g, '\\');
                          }
                          if (edit.newContent) {
                            edit.newContent = edit.newContent
                              .replace(/\\n/g, '\n')
                              .replace(/\\t/g, '\t')
                              .replace(/\\\\/g, '\\');
                          }
                          parsed.edits.push(edit);
                        }
                      } catch (editError) {
                        console.log("[AI Chat] Could not parse individual edit:", editStr.substring(0, 100));
                      }
                    }
                  } catch (editsError) {
                    console.log("[AI Chat] Could not extract edits");
                  }
                }

                console.log("[AI Chat] Recovered response with", parsed.edits.length, "edits via regex extraction");
              } else {
                throw secondError;
              }
            }
          }

          // Validate the structure - accept blockId based format
          const response = typeof parsed.response === 'string' ? parsed.response : aiResponse;
          const edits = Array.isArray(parsed.edits) ? parsed.edits.filter((edit: {
            blockId?: string;
            replaceWith?: string;
            action?: string;
            description?: string;
          }) => {
            // Only accept blockId based format with valid action
            return typeof edit.blockId === 'string' &&
              edit.blockId.length > 0 &&
              typeof edit.action === 'string' &&
              ['replace', 'delete', 'insertAfter'].includes(edit.action);
          }).map((edit: {
            blockId: string;
            replaceWith?: string;
            action: string;
            description?: string;
          }) => ({
            blockId: edit.blockId,
            replaceWith: edit.replaceWith || '',
            action: edit.action,
            description: edit.description || '',
          })) : [];

          console.log("[AI Chat] Parsed", edits.length, "valid edits from response");
          console.log("[AI Chat] Edits:", JSON.stringify(edits, null, 2));

          ctx.body = {
            data: {
              response,
              edits,
            },
          };
        } catch (parseError) {
          console.error("[AI Chat] Failed to parse JSON response:", parseError);
          console.log("[AI Chat] Raw response (first 500 chars):", aiResponse.substring(0, 500));

          // If not valid JSON, try to extract any useful information
          // and return as regular response
          ctx.body = {
            data: {
              response: aiResponse,
              edits: [],
            },
          };
        }
      } else {
        ctx.body = {
          data: {
            response: aiResponse,
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      ctx.body = {
        data: {
          response: `I encountered an error while processing your request: ${errorMessage}`,
        },
      };
    }
  }
);

router.post(
  "ai.models",
  auth(),
  validate(T.AiModelsSchema),
  async (ctx: APIContext<T.AiModelsReq>) => {
    const { clientApiKeys } = ctx.input.body;

    // Build providers list based on available keys (server or client)
    const providers: Array<{
      id: string;
      name: string;
      models: Array<{ id: string; name: string }>;
    }> = [];

    let serverHasKeys = false;

    for (const [providerId, config] of Object.entries(PROVIDERS)) {
      const serverKey = env[config.envKey] as string | undefined;
      const clientKey = clientApiKeys?.[providerId];
      const hasKey = !!serverKey || !!clientKey;

      if (serverKey) {
        serverHasKeys = true;
      }

      if (hasKey) {
        providers.push({
          id: providerId,
          name: config.name,
          models: config.models,
        });
      }
    }

    // Determine defaults
    const defaultProviderId = providers.length > 0 ? providers[0].id : null;
    const defaultModel = defaultProviderId
      ? PROVIDERS[defaultProviderId]?.defaultModel || providers[0]?.models[0]?.id
      : null;

    ctx.body = {
      data: {
        providers,
        // Send all provider configs so client knows what's available
        availableProviders: Object.entries(PROVIDERS).map(([id, config]) => ({
          id,
          name: config.name,
        })),
        defaultProvider: defaultProviderId,
        defaultModel,
        serverHasKeys,
      },
    };
  }
);

// SSE Streaming endpoint for real-time AI responses
router.post(
  "ai.chat.stream",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(T.AiChatStreamSchema),
  async (ctx: APIContext<T.AiChatStreamReq>) => {
    const {
      message,
      documentContext,
      history,
      provider,
      model,
      mode,
      clientApiKey,
      continueFrom,
      maxEditsPerIteration = 12,
      iterationCount = 1,
      contextSummary,
      summarizedAtIteration = 0
    } = ctx.input.body;

    console.log("[AI Stream] Request received, mode:", mode, "iteration:", iterationCount, "continueFrom:", !!continueFrom);

    // Determine provider and model
    const availableProviders = Object.keys(PROVIDERS).filter(pid => {
      const key = getApiKeyForProvider(pid, pid === provider ? clientApiKey : undefined);
      return !!key;
    });

    const selectedProvider = provider && availableProviders.includes(provider)
      ? provider
      : availableProviders[0] || null;

    const activeApiKey = selectedProvider
      ? getApiKeyForProvider(selectedProvider, clientApiKey)
      : undefined;

    let selectedModel = model;
    if (!selectedModel) {
      if (selectedProvider === "openai") {
        selectedModel = env.OPENAI_MODEL || "gpt-3.5-turbo";
      } else {
        selectedModel = env.GEMINI_MODEL || "gemini-2.5-flash";
      }
    }

    // Check for API keys
    if (!selectedProvider || !activeApiKey) {
      ctx.status = 400;
      ctx.body = { error: "No AI provider configured" };
      return;
    }

    // Set up SSE response
    ctx.request.socket.setTimeout(0);
    ctx.request.socket.setNoDelay(true);
    ctx.request.socket.setKeepAlive(true);

    ctx.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const stream = new PassThrough();
    ctx.status = 200;
    ctx.body = stream;

    // Helper to send SSE events
    const sendEvent = (event: string, data: unknown) => {
      stream.write(`event: ${event}\n`);
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Build messages
      const messages: Array<{ role: string; content: string }> = [];

      // System prompt based on mode
      let systemPrompt: string;
      if (mode === "agent") {
        systemPrompt = buildIterativeAgentPrompt(
          documentContext,
          continueFrom,
          maxEditsPerIteration,
          iterationCount,
          contextSummary
        );
      } else {
        systemPrompt = `<identity>
You are a knowledgeable AI assistant integrated into Outline, a collaborative document editor.
</identity>

<capabilities>
- Answer questions about documents and their content
- Help with writing, editing, and structuring text
- Provide explanations, summaries, and suggestions
- Assist with formatting and markdown
</capabilities>

<communication_style>
- Be CONCISE: Get to the point, avoid filler phrases
- Be HELPFUL: Provide actionable, useful information
- Be CLEAR: Use simple language, structure with markdown
- MATCH user's language: Respond in the same language as the user
</communication_style>

<formatting>
- Use markdown for structure: **bold**, *italic*, \`code\`, lists
- Use headers sparingly (## and ### only when helpful)
- Keep paragraphs short and focused
- Use bullet points for lists of items
</formatting>

<guidelines>
- NO preamble ("Here's what I found...", "I'd be happy to...")
- NO postamble ("Let me know if you need more...", "Hope this helps!")
- Answer questions directly
- Provide examples when they add clarity
- If unsure, say so briefly rather than guessing
</guidelines>`;

        if (documentContext) {
          systemPrompt += `\n\nThe user is currently working on a document. Here's the content:\n${documentContext.substring(0, 20000)}`;
        }
      }

      messages.push({ role: "system", content: systemPrompt });

      // Add history (use provided history, which may already be summarized on client)
      if (history && history.length > 0) {
        // If we have a context summary, we don't need as much history
        const historyLimit = contextSummary ? 4 : 10;
        for (const msg of history.slice(-historyLimit)) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Add current message
      messages.push({ role: "user", content: message });

      sendEvent("start", { provider: selectedProvider, model: selectedModel });

      let fullContent = "";

      // Stream based on provider
      if (selectedProvider === "openai") {
        for await (const chunk of streamOpenAI(messages, selectedModel, activeApiKey)) {
          fullContent += chunk;
          sendEvent("chunk", { content: chunk });
        }
      } else if (selectedProvider === "gemini") {
        for await (const chunk of streamGemini(messages, selectedModel, activeApiKey)) {
          fullContent += chunk;
          sendEvent("chunk", { content: chunk });
        }
      }

      // For agent mode, parse the response and extract edits
      if (mode === "agent") {
        try {
          // Clean up response
          let cleanedResponse = fullContent.trim();

          // Handle empty response (iteration complete with no more work)
          if (!cleanedResponse) {
            sendEvent("complete", {
              response: "Toutes les modifications ont été appliquées.",
              edits: [],
              hasMore: false
            });
            stream.end();
            return;
          }

          // Remove markdown code blocks
          if (cleanedResponse.startsWith("```json")) {
            cleanedResponse = cleanedResponse.slice(7);
          } else if (cleanedResponse.startsWith("```")) {
            cleanedResponse = cleanedResponse.slice(3);
          }
          if (cleanedResponse.endsWith("```")) {
            cleanedResponse = cleanedResponse.slice(0, -3);
          }
          cleanedResponse = cleanedResponse.trim();

          // Try to find a complete JSON object
          let jsonStart = cleanedResponse.indexOf("{");
          if (jsonStart === -1) {
            // No JSON found - might be a plain text response
            // Check if it looks like a completion message
            const lowerContent = cleanedResponse.toLowerCase();
            if (lowerContent.includes("termin") || lowerContent.includes("complet") ||
              lowerContent.includes("fini") || lowerContent.includes("done") ||
              lowerContent.includes("all") || cleanedResponse.length < 100) {
              sendEvent("complete", {
                response: cleanedResponse || "Modifications terminées.",
                edits: [],
                hasMore: false
              });
              stream.end();
              return;
            }
            throw new Error("No JSON object found in response");
          }

          // Find matching closing brace
          let depth = 0;
          let jsonEnd = -1;
          let inString = false;
          let escapeNext = false;

          for (let i = jsonStart; i < cleanedResponse.length; i++) {
            const char = cleanedResponse[i];

            if (escapeNext) {
              escapeNext = false;
              continue;
            }

            if (char === '\\') {
              escapeNext = true;
              continue;
            }

            if (char === '"' && !escapeNext) {
              inString = !inString;
              continue;
            }

            if (!inString) {
              if (char === '{') depth++;
              else if (char === '}') {
                depth--;
                if (depth === 0) {
                  jsonEnd = i + 1;
                  break;
                }
              }
            }
          }

          let parsed: { response?: string; edits?: unknown[]; hasMore?: boolean };

          if (jsonEnd === -1) {
            // JSON is incomplete - extract what we can
            console.log("[AI Stream] JSON appears incomplete, extracting partial data");

            // Extract response field using regex
            const responseMatch = cleanedResponse.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            const extractedResponse = responseMatch
              ? responseMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
              : "Modifications en cours...";

            // Extract complete edit objects from the edits array
            const completeEdits: Array<{ blockId?: string; id?: string; action?: string; replaceWith?: string; description?: string }> = [];
            const editsMatch = cleanedResponse.match(/"edits"\s*:\s*\[/);
            if (editsMatch) {
              const editsStart = cleanedResponse.indexOf(editsMatch[0]) + editsMatch[0].length;
              let editDepth = 0;
              let editStart = -1;
              inString = false;
              escapeNext = false;

              for (let i = editsStart; i < cleanedResponse.length; i++) {
                const char = cleanedResponse[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (char === '\\') { escapeNext = true; continue; }
                if (char === '"' && !escapeNext) { inString = !inString; continue; }

                if (!inString) {
                  if (char === '{') {
                    if (editDepth === 0) editStart = i;
                    editDepth++;
                  } else if (char === '}') {
                    editDepth--;
                    if (editDepth === 0 && editStart !== -1) {
                      // Found a complete edit object
                      const editJson = cleanedResponse.substring(editStart, i + 1);
                      try {
                        const edit = JSON.parse(editJson);
                        completeEdits.push(edit);
                      } catch {
                        // Skip invalid edit
                      }
                      editStart = -1;
                    }
                  } else if (char === ']' && editDepth === 0) {
                    break; // End of edits array
                  }
                }
              }
            }

            // Check for hasMore
            const hasMoreMatch = cleanedResponse.match(/"hasMore"\s*:\s*(true|false)/);
            const hasMore = hasMoreMatch ? hasMoreMatch[1] === "true" : true; // Default to true for incomplete

            parsed = {
              response: extractedResponse,
              edits: completeEdits,
              hasMore,
            };
          } else {
            cleanedResponse = cleanedResponse.substring(jsonStart, jsonEnd);
            parsed = JSON.parse(cleanedResponse);
          }

          const response = typeof parsed.response === "string" ? parsed.response : "Modifications appliquées";
          const hasMore = parsed.hasMore === true;
          const edits = Array.isArray(parsed.edits)
            ? parsed.edits.filter((edit: { blockId?: string; id?: string; action?: string }) => {
              // Accept both 'blockId' and 'id' fields
              const blockId = edit.blockId || edit.id;
              return typeof blockId === "string" &&
                blockId.length > 0 &&
                typeof edit.action === "string";
            }).map((edit: {
              blockId?: string;
              id?: string;
              replaceWith?: string;
              action: string;
              targetBlockId?: string;
              description?: string
            }) => ({
              blockId: edit.blockId || edit.id || "",
              replaceWith: edit.replaceWith || "",
              action: edit.action,
              targetBlockId: edit.targetBlockId,
              description: edit.description || "",
            }))
            : [];

          sendEvent("complete", {
            response,
            edits,
            hasMore,
            rawContent: fullContent
          });
        } catch (parseError) {
          console.error("[AI Stream] Failed to parse agent response:", parseError);
          console.error("[AI Stream] Raw content (first 1000 chars):", fullContent.substring(0, 1000));

          // Try to extract at least the response text from the raw content
          let extractedResponse = fullContent;
          try {
            // Try to find and extract just the response field
            const responseMatch = fullContent.match(/"response"\\s*:\\s*"([^"]*(?:\\\\"[^"]*)*)"/);
            if (responseMatch) {
              extractedResponse = responseMatch[1].replace(/\\\\"/g, '"').replace(/\\\\n/g, '\n');
            }
          } catch {
            // Keep original content
          }

          sendEvent("complete", {
            response: extractedResponse,
            edits: [],
            hasMore: false
          });
        }
      } else {
        sendEvent("complete", { response: fullContent });
      }

      stream.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("[AI Stream] Error:", errorMessage);
      sendEvent("error", { message: errorMessage });
      stream.end();
    }
  }
);

export default router;
