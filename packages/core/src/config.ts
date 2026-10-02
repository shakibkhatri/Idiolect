import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  emails: z.array(z.string()).min(1),
  languages: z.array(z.enum(["kotlin"])).default(["kotlin"]),
  llm: z.object({ provider: z.enum(["anthropic", "openai", "gemini", "openai-compatible", "none"]).default("none"), model: z.string().optional(), apiKeyEnv: z.string().optional(), baseUrl: z.string().optional() }).default({}),
  sampling: z.object({ maxTokens: z.number().default(40000) }).default({}),
  confidenceThreshold: z.number().default(0.6),
  minSampleSize: z.number().default(20),
  sync: z.object({ targets: z.array(z.string()).default(["AGENTS.md", "CLAUDE.md"]) }).default({}),
  refresh: z.object({ everyCommits: z.number().default(50) }).default({}),
  ignore: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

export const configPath = (repo: string) => join(repo, ".idiolect", "config.json");

export async function loadConfig(repo: string): Promise<Config | undefined> {
  const raw = await readFile(configPath(repo), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : ConfigSchema.parse(JSON.parse(raw));
}

export async function saveConfig(repo: string, config: Config) {
  await mkdir(join(repo, ".idiolect"), { recursive: true });
  await writeFile(configPath(repo), JSON.stringify(config, null, 2) + "\n");
}
