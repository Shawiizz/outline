import Router from "koa-router";
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
      systemPrompt = `You are an AI agent for Outline (a rich-text document editor). Respond ONLY with raw JSON.

FORMAT:
{"response": "explanation", "edits": [{"blockId": "xxx", "replaceWith": "content", "action": "delete|replace|insertAfter", "description": "what"}]}

DOCUMENT STRUCTURE:
- Regular blocks: [ID:blk_xxx] content
- Lists: [LIST:blk_xxx] (type list with N items)
  - List items: [ITEM:blk_xxx_item0] - content
- Non-editable standalone: [ID:blk_xxx] [NON-EDITABLE:type] description

BLOCK TYPES & IDs:
1. **Regular blocks** (paragraph, heading, etc.): Use [ID:blk_xxx]
2. **List items**: Use [ITEM:blk_xxx_itemN] - individual items you can edit separately
3. **Entire lists**: Use [LIST:blk_xxx] to delete/replace the whole list
4. **Non-editable standalone blocks** (images, videos, tables at top level): Can only DELETE

SPECIAL MARKDOWN SYNTAX - MUST PRESERVE EXACTLY:
- **Images**: \`![alt](url)\` or \`![alt](url "=WIDTHxHEIGHT")\`
  Example: \`![](https://example.com/img.png "=800x600")\`
  
  ⚠️ CRITICAL: Image markdown MUST be on ONE LINE - NEVER add line breaks!
  ✅ Correct: \`![](https://example.com/img.png "=800x600")\`
  ❌ WRONG: \`![]\n(https://example.com/img.png "=800x600")\` ← This BREAKS the image!
  
- Copy the ENTIRE image markdown as ONE string, unchanged
- Never split \`![...](url)\` across multiple lines

ACTIONS:
- "replace": Replace content. For list items, provide the FULL content including any images
- "delete": Remove the block entirely
- "insertAfter": Add new content after this block

CRITICAL RULES:

1. **LIST ITEMS ARE INDIVIDUAL**: Each [ITEM:xxx] is separate. To modify one item, target its specific ID.

2. **ADDING TO LISTS**: Use "insertAfter" on the LAST item of the list with the new item's text.
   Example: {"blockId": "blk_abc_item2", "action": "insertAfter", "replaceWith": "New fourth item", "description": "Add item"}

3. **ITEM CONTENT**: When replacing a list item, provide ONLY the text content, NOT the bullet/number prefix.
   ✅ "replaceWith": "Updated item text"
   ❌ "replaceWith": "- Updated item text"

4. **IMAGES IN CONTENT**: If an item contains an image like \`![](url "=WxH")\`:
   - Copy the ENTIRE image markdown on ONE LINE - no line breaks!
   - The format is: \`![alt](url "=WIDTHxHEIGHT")\` - all on one line
   - You can add/modify text BEFORE or AFTER the image
   - Example original: \`Text before ![](https://x.com/img.png "=800x600")Text after\`
   - Example modified: \`New text ![](https://x.com/img.png "=800x600")New text after\`

5. **NON-EDITABLE STANDALONE BLOCKS**: [NON-EDITABLE:type] at top level can ONLY be deleted.

6. **PRESERVE STRUCTURE**: Don't convert paragraphs to lists or vice versa unless explicitly asked.

7. **HEADINGS**: When replacing a heading, include the markdown prefix to set the level:
   - \`# Title\` for h1, \`## Title\` for h2, \`### Title\` for h3, etc.
   - To keep the same level, check the original content and use the same number of \`#\`
   - Example: {"blockId": "blk_xyz", "action": "replace", "replaceWith": "## New Heading Title", "description": "Update heading"}

EXAMPLES:

1. Modify a list item:
   {"blockId": "blk_abc_item1", "action": "replace", "replaceWith": "Updated second item", "description": "Fix typo"}

2. Add item to end of bullet list (list has items 0,1,2):
   {"blockId": "blk_abc_item2", "action": "insertAfter", "replaceWith": "Fourth item", "description": "Add new item"}

3. Delete a specific list item:
   {"blockId": "blk_abc_item1", "action": "delete", "replaceWith": "", "description": "Remove item"}

4. Delete entire list:
   {"blockId": "blk_abc", "action": "delete", "replaceWith": "", "description": "Remove whole list"}

5. Modify a paragraph:
   {"blockId": "blk_xyz", "action": "replace", "replaceWith": "New paragraph text", "description": "Update text"}

6. Delete an image (NON-EDITABLE standalone block):
   {"blockId": "blk_img", "action": "delete", "replaceWith": "", "description": "Remove image"}

7. Modify list item that contains an image (add text, keep image on ONE LINE):
   Original: "Check this: ![](https://x.com/img.png \\"=800x600\\")Result above."
   {"blockId": "blk_abc_item2", "action": "replace", "replaceWith": "Check this screenshot: ![](https://x.com/img.png \\"=800x600\\")The result shows success!", "description": "Improve text"}

WRONG EXAMPLES:
❌ {"blockId": "blk_img", "action": "replace", ...} // Can't replace standalone non-editable block!
❌ {"blockId": "blk_abc_item0", "replaceWith": "- Text"} // Don't include bullet prefix!
❌ {"replaceWith": "Text ![]\n(url \\"=WxH\\")"} // NEVER split image markdown across lines!

RULES:
1. Use EXACT IDs from [ID:], [LIST:], or [ITEM:] markers
2. Match user's language
3. No changes needed? {"response": "answer", "edits": []}`;

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
      systemPrompt = `You are a helpful AI assistant integrated into a document editor called Outline. 
You help users with their writing, answer questions about their documents, and provide helpful suggestions.
Be concise, helpful, and friendly. Format your responses using markdown when appropriate.`;

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

export default router;
