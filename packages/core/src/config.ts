import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** Who the developer is and which LLM they use. Lives in the home directory, never inside a repo. */
export const UserConfigSchema = z.object({
  name: z.string().optional(),
  emails: z.array(z.string()).min(1),
  llm: z.object({ provider: z.enum(["claude-cli", "anthropic", "openai", "gemini", "openai-compatible", "none"]).default("none"), model: z.string().optional(), apiKeyEnv: z.string().optional(), baseUrl: z.string().optional() }).prefault({}),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

/** Repo-level settings. Nothing personal, safe to commit, every field has a default so the file is optional. */
export const RepoConfigSchema = z.object({
  languages: z.array(z.enum(["kotlin", "typescript", "python", "go"])).default(["kotlin", "typescript", "python", "go"]),
  sampling: z.object({ maxTokens: z.number().default(40000) }).prefault({}),
  confidenceThreshold: z.number().default(0.6),
  minSampleSize: z.number().default(20),
  sync: z.object({ targets: z.array(z.string()).optional() }).prefault({}),
  refresh: z.object({ everyCommits: z.number().default(50) }).prefault({}),
  // floors for Unbot and check_style: items before a ratio or median counts, lines before a density counts, items for located rules, excess over the developer's number
  check: z.object({ minItems: z.number().default(10), minLines: z.number().default(100), minLocated: z.number().default(3), excess: z.number().default(2) }).prefault({}),
  ignore: z.array(z.string()).default([]),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const userConfigPath = () => join(homedir(), ".idiolect", "config.json");
export const repoConfigPath = (repo: string) => join(repo, ".idiolect", "config.json");

export async function loadUserConfig(): Promise<UserConfig | undefined> {
  const raw = await readFile(userConfigPath(), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : UserConfigSchema.parse(JSON.parse(raw));
}

export async function saveUserConfig(config: UserConfig) {
  await mkdir(join(homedir(), ".idiolect"), { recursive: true });
  await writeFile(userConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

export async function loadRepoConfig(repo: string): Promise<RepoConfig> {
  const raw = await readFile(repoConfigPath(repo), "utf8").catch(() => "{}");
  return RepoConfigSchema.parse(JSON.parse(raw));
}

/** Creates <repo>/.idiolect and ignores cache and eval output inside it, so config.json stays the only committable file. */
export async function ensureRepoDir(repo: string): Promise<string> {
  const dir = join(repo, ".idiolect");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "cache/\neval/\n", { flag: "wx" }).catch(() => undefined);
  return dir;
}

export async function saveRepoConfig(repo: string, config: Partial<RepoConfig>) {
  await ensureRepoDir(repo);
  await writeFile(repoConfigPath(repo), JSON.stringify(config, null, 2) + "\n");
}
