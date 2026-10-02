import { checkStyle, git, languageOf, loadRepoConfig, renderStyleMd, rewriteLikeMe, appliesTo, isServed, type LlmProvider, type Profile } from "@shakibkhatri/idiolect-core";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";

export type ServerDeps = {
  profile: () => Promise<Profile | undefined>;
  provider?: () => Promise<LlmProvider | undefined>;
  cwd?: string;
};

const LANGUAGES = ["kotlin", "typescript", "python", "go"] as const;

export const WRITE_LIKE_ME = `This developer has a style profile served by the idiolect MCP server.
Before writing or editing code for them, call get_style with the file path so you get the rules for that language and repo.
Write the code, then call check_style on the result and fix every violation it reports, then check again.
When asked to make existing code sound like them, call rewrite_like_me instead of rewriting by hand.
Rules with numbers bound how much to write. Match those before matching voice.`;

/** Profile, repo and threshold for one call. Resolves file against cwd and the repo from the file, else from cwd. */
export function createIdiolectServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "idiolect", version: "0.0.1" });
  const cwd = deps.cwd ?? process.cwd();

  const context = async (file?: string) => {
    const profile = await deps.profile();
    if (!profile) throw new Error("no style profile yet. Run: idiolect init, then idiolect scan");
    const abs = file ? resolve(cwd, file) : undefined;
    // the file may not exist yet, so fall back to the directory the client started us in
    const toplevel = (dir: string) => git(dir, ["rev-parse", "--show-toplevel"]).then((x) => x.trim()).catch(() => "");
    const repo = (abs && (await toplevel(dirname(abs)))) || (await toplevel(cwd)) || undefined;
    const { confidenceThreshold: threshold } = await loadRepoConfig(repo ?? cwd);
    return { profile, repo, threshold, file: abs ? relative(repo ?? cwd, abs) : undefined };
  };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `idiolect: ${(e as Error).message}` }] });

  server.registerTool("get_style", {
    title: "Get style rules",
    description: "The developer's style rules as Markdown. Pass the file you are about to write so only its language, path and repo rules come back.",
    inputSchema: { file_path: z.string().optional().describe("file you are about to write or edit"), language: z.enum(LANGUAGES).optional() },
  }, async ({ file_path, language }) => {
    try {
      const c = await context(file_path);
      return text(renderStyleMd(c.profile, { threshold: c.threshold, repo: c.repo, file: c.file, language: language ?? (file_path ? languageOf(file_path) : undefined) }));
    } catch (e) { return fail(e); }
  });

  const ViolationOut = z.object({ rule_id: z.string(), line: z.number().optional(), message: z.string(), suggestion: z.string() });
  server.registerTool("check_style", {
    title: "Check code against the style",
    description: "Compares code you wrote against the developer's measured habits: comment density and voice, naming, structure, error handling, AI tells. Returns violations with line numbers where they can be located. It measures quantities and patterns, not prose quality.",
    inputSchema: { code: z.string(), language: z.enum(LANGUAGES).default("kotlin"), file_path: z.string().optional().describe("where the code will live, for test detection and path rules") },
    outputSchema: { violations: z.array(ViolationOut) },
  }, async ({ code, language, file_path }) => {
    try {
      const c = await context(file_path);
      const violations = (await checkStyle(c.profile, code, { language, threshold: c.threshold, repo: c.repo, file: c.file }))
        .map((v) => ({ rule_id: v.ruleId, ...(v.line ? { line: v.line } : {}), message: v.message, suggestion: v.suggestion }));
      const body = violations.length
        ? violations.map((v) => `${v.line ? `line ${v.line}: ` : ""}${v.suggestion} (${v.message})`).join("\n")
        : "No violations. The measured habits match.";
      return { ...text(body), structuredContent: { violations } };
    } catch (e) { return fail(e); }
  });

  server.registerTool("rewrite_like_me", {
    title: "Rewrite code in the developer's style",
    description: "Rewrites code so it reads as if the developer wrote it, keeping behaviour identical. Needs the LLM provider from idiolect init.",
    inputSchema: { code: z.string(), language: z.enum(LANGUAGES).default("kotlin"), scope: z.enum(["comments", "names", "all"]).default("all"), file_path: z.string().optional() },
    outputSchema: { code: z.string(), changes: z.array(z.string()) },
  }, async ({ code, language, scope, file_path }) => {
    try {
      const provider = await deps.provider?.();
      if (!provider) throw new Error("rewrite_like_me needs an LLM provider. Run: idiolect init");
      const c = await context(file_path);
      const out = await rewriteLikeMe(c.profile, code, { language, threshold: c.threshold, repo: c.repo, file: c.file, scope }, provider);
      return { ...text(`${out.code}\n\nChanges:\n${out.changes.map((x) => `- ${x}`).join("\n") || "- none"}`), structuredContent: out };
    } catch (e) { return fail(e); }
  });

  server.registerTool("get_team_rules", {
    title: "Get team rules",
    description: "Team conventions that apply to a path, with how often reviewers flagged each. Empty until team mode has run.",
    inputSchema: { path: z.string().describe("file or directory, relative to the repo") },
  }, async ({ path }) => {
    try {
      const c = await context(path);
      const team = c.profile.rules.filter((r) => r.scope === "team" && isServed(r, c.threshold) && appliesTo(r, { file: c.file }));
      if (!team.length) return text("No team rules for this path yet. Team mode (idiolect team scan) learns them from PR reviews.");
      return text(team.map((r) => `- ${r.text}${r.evidence.count ? ` (flagged ${r.evidence.count}x)` : ""}`).join("\n"));
    } catch (e) { return fail(e); }
  });

  server.registerResource("profile", new ResourceTemplate("style://profile/{language}", {
    list: async () => {
      const profile = await deps.profile();
      return { resources: Object.keys(profile?.stats ?? {}).map((l) => ({ uri: `style://profile/${l}`, name: `${l} style`, mimeType: "text/markdown" })) };
    },
  }), { title: "Style profile", description: "The developer's STYLE.md for one language", mimeType: "text/markdown" }, async (uri, { language }) => {
    const c = await context();
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderStyleMd(c.profile, { threshold: c.threshold, repo: c.repo, language: String(language) }) }] };
  });

  server.registerPrompt("write_like_me", { title: "Write like me", description: "Tells the agent to fetch the style before writing and check after" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: WRITE_LIKE_ME } }],
  }));

  return server;
}
