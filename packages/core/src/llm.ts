import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { UserConfig } from "./config.js";

export type LlmRequest<T> = { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number };
export type LlmProvider = { name: string; model: string; complete<T>(req: LlmRequest<T>): Promise<T> };

const DEFAULTS = {
  anthropic: { model: "claude-opus-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { model: undefined, apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
  "openai-compatible": { model: undefined, apiKeyEnv: "OPENAI_API_KEY", baseUrl: "http://localhost:11434/v1" },
  gemini: { model: undefined, apiKeyEnv: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
} as const;

/** Returns undefined when no provider is configured, which the writer treats as "baseline rules only". */
export function createProvider(llm: UserConfig["llm"]): LlmProvider | undefined {
  if (llm.provider === "none") return undefined;
  if (llm.provider === "claude-cli") return claudeCliProvider(llm.model);
  const d = DEFAULTS[llm.provider];
  const model = llm.model ?? d.model;
  if (!model) throw new Error(`llm.model is required for provider ${llm.provider}`);
  const apiKeyEnv = llm.apiKeyEnv ?? d.apiKeyEnv;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey && llm.provider !== "openai-compatible") throw new Error(`${apiKeyEnv} is not set`);
  const baseUrl = llm.baseUrl ?? ("baseUrl" in d ? d.baseUrl : undefined);

  if (llm.provider === "anthropic") return anthropicProvider(model, new Anthropic({ apiKey }));
  if (llm.provider === "gemini") return geminiProvider(model, apiKey!, baseUrl!);
  return openAiCompatibleProvider(llm.provider, model, apiKey ?? "ollama", baseUrl!);
}

// claude's validator rejects the $schema header zod emits
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Runs the user's installed Claude Code in headless mode. Uses their existing login, no API key, we never touch their tokens.
 * Safe mode and our own system prompt keep their CLAUDE.md, skills and the agent prompt out of the call.
 */
function claudeCliProvider(model?: string): LlmProvider {
  let safeMode = true;
  const run = <T>(req: LlmRequest<T>): Promise<T> => {
    const args = ["-p", ...(safeMode ? ["--safe-mode"] : []), "--output-format", "json", "--no-session-persistence", "--tools", "", "--system-prompt", req.system, "--json-schema", JSON.stringify(jsonSchema(req.schema))];
    if (model) args.push("--model", model);
    return new Promise<T>((resolve, reject) => {
      const child = execFile("claude", args, { cwd: tmpdir(), maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`claude CLI failed: ${err.message} ${stderr}`.trim()));
        let out: { is_error?: boolean; result?: string; structured_output?: unknown };
        try { out = JSON.parse(stdout); } catch { return reject(new Error(`claude CLI returned non-JSON: ${stdout.slice(0, 200)}`)); }
        if (out.is_error) return reject(new Error(`claude CLI: ${out.result ?? "unknown error"}`));
        if (out.structured_output === undefined) return reject(new Error(`claude CLI returned no structured output: ${String(out.result).slice(0, 200)}`));
        try { resolve(req.schema.parse(out.structured_output)); } catch (e) { reject(new Error(`claude CLI output failed validation: ${(e as Error).message.slice(0, 300)}`)); }
      });
      child.stdin!.end(req.user);
    });
  };
  return {
    name: "claude-cli", model: model ?? "default",
    async complete<T>(req: LlmRequest<T>): Promise<T> {
      try { return await run(req); } catch (e) {
        // a Claude Code too old for safe mode still works, it just reads the user's own instructions too
        if (!safeMode || !/unknown option.*--safe-mode/i.test((e as Error).message)) throw e;
        safeMode = false;
        process.stderr.write("warning: this Claude Code has no --safe-mode, your CLAUDE.md is part of every call. Update Claude Code to keep it out\n");
        return run(req);
      }
    },
  };
}

function anthropicProvider(model: string, client: Anthropic): LlmProvider {
  return {
    name: "anthropic", model,
    async complete(req) {
      const res = await client.messages.parse({
        model, max_tokens: req.maxTokens ?? 16000, system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: zodOutputFormat(req.schema) },
      });
      if (res.stop_reason === "refusal") throw new Error("the model refused this request");
      if (!res.parsed_output) throw new Error(`model returned no parsable output (stop_reason ${res.stop_reason})`);
      return res.parsed_output;
    },
  };
}

function openAiCompatibleProvider(name: string, model: string, apiKey: string, baseUrl: string): LlmProvider {
  return {
    name, model,
    complete: (req) => withRetry(req, async (user) => {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: req.system }, { role: "user", content: user }], response_format: { type: "json_object" }, max_tokens: req.maxTokens ?? 16000 }),
      });
      if (!res.ok) throw new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return json.choices[0]?.message.content ?? "";
    }),
  };
}

function geminiProvider(model: string, apiKey: string, baseUrl: string): LlmProvider {
  return {
    name: "gemini", model,
    complete: (req) => withRetry(req, async (user) => {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: req.maxTokens ?? 16000 } }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
      return json.candidates[0]?.content.parts.map((p) => p.text).join("") ?? "";
    }),
  };
}

/** Parses and validates text output; on failure asks once more with the validation error attached. */
async function withRetry<T>(req: LlmRequest<T>, call: (user: string) => Promise<string>): Promise<T> {
  let user = req.user;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await call(user);
    try {
      return req.schema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      user = `${req.user}\n\nYour previous answer was not valid JSON for the required schema: ${lastError.slice(0, 500)}\nReturn only the JSON object.`;
    }
  }
  throw new Error(`model output failed validation twice: ${lastError.slice(0, 300)}`);
}
