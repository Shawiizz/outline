import { z } from "zod";

export const AiChatSchema = z.object({
  body: z.object({
    message: z.string().min(1).max(4000),
    documentContext: z.string().optional(),
    provider: z.enum(["openai", "gemini"]).optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "agent"]).optional().default("ask"),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })).optional(),
  }),
});

export type AiChatReq = z.infer<typeof AiChatSchema>;

export const AiModelsSchema = z.object({
  body: z.object({}),
});

export type AiModelsReq = z.infer<typeof AiModelsSchema>;
