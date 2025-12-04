import { z } from "zod";

export const AiChatSchema = z.object({
  body: z.object({
    message: z.string().min(1).max(4000),
    documentContext: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "agent"]).optional().default("ask"),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })).optional(),
    // Client-provided API key for the selected provider
    clientApiKey: z.string().optional(),
  }),
});

export type AiChatReq = z.infer<typeof AiChatSchema>;

export const AiChatStreamSchema = z.object({
  body: z.object({
    message: z.string().min(1).max(4000),
    documentContext: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "agent"]).optional().default("ask"),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })).optional(),
    // Client-provided API key for the selected provider
    clientApiKey: z.string().optional(),
    // For iterative operations - continue from previous response
    continueFrom: z.string().optional(),
    // Max edits per iteration (for agent mode) - keep small for precision
    maxEditsPerIteration: z.number().optional().default(12),
    // Current iteration count
    iterationCount: z.number().optional().default(1),
    // Context summary (for long conversations)
    contextSummary: z.string().optional(),
    // Iteration at which context was summarized
    summarizedAtIteration: z.number().optional().default(0),
  }),
});

export type AiChatStreamReq = z.infer<typeof AiChatStreamSchema>;

export const AiModelsSchema = z.object({
  body: z.object({
    // Client-provided API keys per provider (e.g., { openai: "sk-...", gemini: "AIza..." })
    clientApiKeys: z.record(z.string(), z.string()).optional(),
  }),
});

export type AiModelsReq = z.infer<typeof AiModelsSchema>;
