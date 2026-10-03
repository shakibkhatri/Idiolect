import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createProvider } from "./llm.js";

const realPath = process.env.PATH;
afterEach(() => { process.env.PATH = realPath; });

// a stand-in claude that answers with the arguments it was called with
async function fakeClaude(rejectSafeMode: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "idiolect-claude-"));
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (${rejectSafeMode} && args.includes("--safe-mode")) { console.error("error: unknown option '--safe-mode'"); process.exit(1); }
process.stdin.resume().on("end", () => console.log(JSON.stringify({ structured_output: { args } })));
`;
  await writeFile(join(dir, "claude"), script);
  await chmod(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}${delimiter}${realPath}`;
}
const Args = z.object({ args: z.array(z.string()) });

test("claude-cli runs in safe mode with only our system prompt, so the user's CLAUDE.md stays out", async () => {
  await fakeClaude(false);
  const { args } = await createProvider({ provider: "claude-cli" })!.complete({ system: "be terse", user: "hi", schema: Args });
  expect(args).toContain("--safe-mode");
  expect(args[args.indexOf("--system-prompt") + 1]).toBe("be terse");
  expect(args).not.toContain("--append-system-prompt");
});

test("claude-cli falls back without safe mode on a Claude Code that does not know the flag", async () => {
  await fakeClaude(true);
  const provider = createProvider({ provider: "claude-cli" })!;
  expect((await provider.complete({ system: "s", user: "u", schema: Args })).args).not.toContain("--safe-mode");
  expect((await provider.complete({ system: "s", user: "u", schema: Args })).args).not.toContain("--safe-mode");
});
