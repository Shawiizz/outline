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

// Available models configuration
const AVAILABLE_MODELS = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
    { id: "gpt-4", name: "GPT-4" },
    { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
  ],
  gemini: [
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],
};

async function callOpenAI(
  messages: Array<{ role: string; content: string }>,
  model: string,
  jsonMode = false
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
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
  jsonMode = false
): Promise<string> {
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
        "x-goog-api-key": env.GEMINI_API_KEY || "",
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

    const { message, documentContext, history, provider, model, mode } = ctx.input.body;

    console.log("[AI Chat] Request received, documentContext length:", documentContext?.length || 0);

    // Determine which provider to use
    const selectedProvider = provider || (env.GEMINI_API_KEY ? "gemini" : "openai");

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
      systemPrompt = `You are an AI agent for Outline (document editor). Respond ONLY with raw JSON (no markdown).

FORMAT:
{"response": "Brief explanation", "edits": [{"startLine": N, "endLine": M, "oldContent": "...", "newContent": "..."}]}

EDIT FORMAT (block-based):
- "startLine": First block number to modify (1-indexed, from the DOCUMENT below)
- "endLine": Last block number to modify (inclusive). Same as startLine for single block.
- "oldContent": The EXACT current content of the block(s) being modified (copy from DOCUMENT). Required for preview.
- "newContent": The replacement text in markdown format. Empty string "" to delete the block(s).
- "insert": Optional boolean. If true, insert newContent AFTER the specified block instead of replacing.

BLOCK TYPES (each counts as one line number):
- Paragraphs (regular text)
- Headings (# Title)
- Code blocks (\`\`\`code\`\`\` - entire block = 1 line number)
- Math blocks ($$ formula $$ - entire block = 1 line number)  
- List items (each bullet/number)
- Blockquotes
- Horizontal rules

EXAMPLES:
1. Replace block 5: {"startLine": 5, "endLine": 5, "oldContent": "old text", "newContent": "new text"}
2. Delete blocks 3-4: {"startLine": 3, "endLine": 4, "oldContent": "content to delete", "newContent": ""}
3. Replace code block: {"startLine": 7, "endLine": 7, "oldContent": "\`\`\`python\\nold code\\n\`\`\`", "newContent": "\`\`\`python\\nnew code\\n\`\`\`"}

RULES:
1. Use EXACT block numbers from the DOCUMENT section below
2. Block numbers are 1-indexed (first block = 1)
3. A code block with multiple lines is still ONE block
4. A math block with multiple lines is still ONE block
5. ALWAYS include oldContent - copy the exact text from the document
6. Preserve formatting (markdown) in newContent
7. Multiple edits: order from HIGHEST to LOWEST line numbers
8. Match user's language in response
9. No edits needed? Return {"response": "answer", "edits": []}`;

      if (documentContext) {
        // Parse markdown into blocks and number them
        // This must match how ProseMirror counts blocks on the frontend
        const parseMarkdownToBlocks = (markdown: string): string[] => {
          const blocks: string[] = [];
          const lines = markdown.split('\n');
          let i = 0;

          while (i < lines.length) {
            const line = lines[i];

            // Skip empty lines between blocks
            if (line.trim() === '') {
              i++;
              continue;
            }

            // Code block (``` ... ```)
            if (line.trim().startsWith('```')) {
              let block = line;
              i++;
              while (i < lines.length && !lines[i].trim().startsWith('```')) {
                block += '\n' + lines[i];
                i++;
              }
              if (i < lines.length) {
                block += '\n' + lines[i]; // Include closing ```
                i++;
              }
              blocks.push(block);
              continue;
            }

            // Math block ($$ ... $$)
            if (line.trim() === '$$') {
              let block = line;
              i++;
              while (i < lines.length && lines[i].trim() !== '$$') {
                block += '\n' + lines[i];
                i++;
              }
              if (i < lines.length) {
                block += '\n' + lines[i]; // Include closing $$
                i++;
              }
              blocks.push(block);
              continue;
            }

            // Regular block (heading, paragraph, list item, etc.)
            blocks.push(line);
            i++;
          }

          return blocks;
        };

        const blocks = parseMarkdownToBlocks(documentContext);
        const numberedDoc = blocks.map((block, i) => {
          const lineNum = (i + 1).toString().padStart(4, ' ');
          // For multi-line blocks, indent continuation lines
          const indentedBlock = block.split('\n').map((line, j) =>
            j === 0 ? `${lineNum} | ${line}` : `     | ${line}`
          ).join('\n');
          return indentedBlock;
        }).join('\n');

        systemPrompt += `

DOCUMENT (with block numbers):
${numberedDoc.substring(0, 25000)}`;
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
      const hasOpenAI = !!env.OPENAI_API_KEY;
      const hasGemini = !!env.GEMINI_API_KEY;

      console.log("[AI Chat] Provider requested:", provider, "| Selected:", selectedProvider);
      console.log("[AI Chat] Model:", selectedModel);
      console.log("[AI Chat] Has OpenAI:", hasOpenAI, "| Has Gemini:", hasGemini);

      if (!hasOpenAI && !hasGemini) {
        ctx.body = {
          data: {
            response: `I'm an AI assistant placeholder. To enable full AI capabilities, please configure one of these environment variables:
- OPENAI_API_KEY for OpenAI/ChatGPT
- GEMINI_API_KEY for Google Gemini

Your message was: "${message}"

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

      if (selectedProvider === "gemini" && hasGemini) {
        aiResponse = await callGemini(messages, selectedModel, requestEdits);
      } else if (selectedProvider === "openai" && hasOpenAI) {
        aiResponse = await callOpenAI(messages, selectedModel, requestEdits);
      } else if (hasGemini) {
        aiResponse = await callGemini(messages, env.GEMINI_MODEL || "gemini-2.5-flash", requestEdits);
      } else {
        aiResponse = await callOpenAI(messages, env.OPENAI_MODEL || "gpt-3.5-turbo", requestEdits);
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

          // Validate the structure
          const response = typeof parsed.response === 'string' ? parsed.response : aiResponse;
          const edits = Array.isArray(parsed.edits) ? parsed.edits.filter((edit: {
            startLine?: number;
            endLine?: number;
            newContent?: string;
            insert?: boolean;
            // Legacy fields
            type?: string;
            oldContent?: string;
          }) => {
            // New line-based format
            if (typeof edit.startLine === 'number') {
              return true; // Valid line-based edit
            }
            // Legacy format validation
            return edit && typeof edit.type === 'string' &&
              (edit.type === 'prepend' || edit.type === 'append' || edit.type === 'replaceAll' ||
                typeof edit.oldContent === 'string' || typeof edit.newContent === 'string');
          }) : [];

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
  async (ctx) => {
    const hasOpenAI = !!env.OPENAI_API_KEY;
    const hasGemini = !!env.GEMINI_API_KEY;

    const providers: Array<{
      id: string;
      name: string;
      models: Array<{ id: string; name: string }>;
    }> = [];

    if (hasOpenAI) {
      providers.push({
        id: "openai",
        name: "OpenAI",
        models: AVAILABLE_MODELS.openai,
      });
    }

    if (hasGemini) {
      providers.push({
        id: "gemini",
        name: "Google Gemini",
        models: AVAILABLE_MODELS.gemini,
      });
    }

    ctx.body = {
      data: {
        providers,
        defaultProvider: hasGemini ? "gemini" : hasOpenAI ? "openai" : null,
        defaultModel: hasGemini
          ? env.GEMINI_MODEL || "gemini-2.5-flash"
          : hasOpenAI
            ? env.OPENAI_MODEL || "gpt-3.5-turbo"
            : null,
      },
    };
  }
);

export default router;
