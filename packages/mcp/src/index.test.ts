import { emptyProfile, type Profile, type Rule } from "@idiolect/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createIdiolectServer } from "./index.js";

const rule = (r: Partial<Rule> & { id: string; text: string }): Rule => ({
  scope: "personal", language: "kotlin", category: "comments", confidence: 0.9, status: "auto", evidence: { examples: [] }, ...r,
});
const profile: Profile = {
  ...emptyProfile("me", ["me@x"]),
  stats: { kotlin: {} as never },
  rules: [
    rule({ id: "kotlin.comments.lowercase-start-ratio.high", text: "Start comments in lowercase.", evidence: { metric: { name: "comments.lowercase-start-ratio", value: 0.95, sampleSize: 400 }, examples: [] } }),
    rule({ id: "avoid.errors.force-unwrap", category: "avoid", text: "Do not use !! to force-unwrap nullable values.", evidence: { metric: { name: "errors.force-unwrap-per-kloc", value: 0.1, sampleSize: 9000 }, examples: [] } }),
    rule({ id: "kotlin.comments.per-100-loc.value", text: "Comment sparingly. About 0.4 comments per 100 lines of code.", evidence: { metric: { name: "comments.per-100-loc", value: 0.4, sampleSize: 9000 }, examples: [] } }),
    rule({ id: "kotlin.structure.guard", category: "structure", text: "Guard with early returns.", evidence: { examples: [{ file: "A.kt", line: 1, snippet: "x" }] } }),
    rule({ id: "kotlin.project.wrapper", category: "framework", text: "Use AppResult.", repo: "/other/repo", evidence: { examples: [{ file: "B.kt", line: 1, snippet: "x" }] } }),
    rule({ id: "kotlin.team.di", scope: "team", category: "framework", text: "Inject via constructor.", paths: ["app/**"], evidence: { examples: [], count: 7 } }),
    rule({ id: "kotlin.low.conf", text: "Never served.", confidence: 0.2 }),
  ],
};

async function connect(provider?: () => Promise<never>) {
  const server = createIdiolectServer({ profile: async () => profile, provider, cwd: tmpdir() });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;

test("get_style serves personal rules for the language, not project rules of another repo or low confidence", async () => {
  const client = await connect();
  const md = textOf(await client.callTool({ name: "get_style", arguments: { file_path: "app/src/Main.kt" } }));
  expect(md).toContain("Start comments in lowercase.");
  expect(md).toContain("Guard with early returns.");
  expect(md).toContain("Inject via constructor.");
  expect(md).not.toContain("AppResult");
  expect(md).not.toContain("Never served");
  const outside = textOf(await client.callTool({ name: "get_style", arguments: { file_path: "lib/src/Main.kt" } }));
  expect(outside).not.toContain("Inject via constructor.");
});

test("check_style finds the lines that break metric rules", async () => {
  const client = await connect();
  const code = `// Loads the user\n// Cached per id\n// Never null\nfun load(id: String): User {\n    return repo.find(id)!!\n}\n`;
  const res = await client.callTool({ name: "check_style", arguments: { code, file_path: "app/src/Repo.kt" } });
  const v = (res.structuredContent as { violations: { rule_id: string; line?: number }[] }).violations;
  expect(v).toContainEqual(expect.objectContaining({ rule_id: "kotlin.comments.lowercase-start-ratio.high", line: 1 }));
  expect(v).toContainEqual(expect.objectContaining({ rule_id: "kotlin.comments.lowercase-start-ratio.high", line: 3 }));
  expect(v).toContainEqual(expect.objectContaining({ rule_id: "avoid.errors.force-unwrap", line: 5 }));
  // four lines are too few for a density rule to say anything
  expect(v).not.toContainEqual(expect.objectContaining({ rule_id: "kotlin.comments.per-100-loc.value" }));
  expect(textOf(res)).toContain("line 1: Start comments in lowercase.");
  const clean = await client.callTool({ name: "check_style", arguments: { code: `// loads the user\nfun load(id: String) = repo.find(id)\n` } });
  expect((clean.structuredContent as { violations: unknown[] }).violations).toEqual([]);
});

test("get_team_rules filters by path, rewrite needs a provider, resource and prompt answer", async () => {
  const client = await connect();
  expect(textOf(await client.callTool({ name: "get_team_rules", arguments: { path: "app/di/Module.kt" } }))).toContain("flagged 7x");
  expect(textOf(await client.callTool({ name: "get_team_rules", arguments: { path: "lib/X.kt" } }))).toContain("No team rules");
  const rewrite = await client.callTool({ name: "rewrite_like_me", arguments: { code: "x" } });
  expect(rewrite.isError).toBe(true);
  expect(textOf(rewrite)).toContain("needs an LLM provider");
  const res = await client.readResource({ uri: "style://profile/kotlin" });
  expect((res.contents[0] as { text: string }).text).toContain("Start comments in lowercase.");
  expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["style://profile/kotlin"]);
  const prompt = await client.getPrompt({ name: "write_like_me" });
  expect((prompt.messages[0]!.content as { text: string }).text).toContain("get_style");
});
