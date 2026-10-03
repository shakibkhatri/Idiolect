import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { apply, find, renderFound, warning } from "./remove.js";
import { removeBlock, syncBlock, syncTargets } from "./sync.js";
import { createTerm } from "./term.js";
import { installHook, removeHook } from "./unbot.js";

const plain = createTerm({ isTTY: false, write: () => 0 }, {});

test("removeBlock gives back the file as it was before the block, or nothing when the file was only the block", () => {
  const mine = "# My project\n\nDo not touch this.\n";
  expect(removeBlock(syncBlock(mine, "- rule", "CLAUDE.md"))).toBe(mine);
  expect(removeBlock(`${syncBlock(mine, "- rule", "CLAUDE.md")}\nAdded later.\n`)).toBe(`${mine}\nAdded later.\n`);
  expect(removeBlock(syncBlock(undefined, "- rule", "AGENTS.md"))).toBeUndefined();
  expect(removeBlock(syncBlock(undefined, "- rule", ".cursor/rules/idiolect.mdc"))).toBeUndefined();
  expect(removeBlock(mine)).toBeNull();
});

test("removeHook takes out only the idiolect lines and reports a hook that is then just a shebang", () => {
  const husky = "#!/bin/sh\nnpx lint-staged\n";
  const ours = "\n# idiolect: check staged files against your style, warn only\nidiolect unbot --staged\n";
  expect(removeHook(husky + ours)).toBe(husky);
  expect(removeHook(`#!/bin/sh\n${ours}`)).toBeUndefined();
  expect(removeHook(husky)).toBeNull();
  expect(removeHook("#!/bin/sh\n# idiolect: mine\necho not ours\n")).toBeNull();
});

test("level 1 leaves the project folder, level 2 gives the repo back as it was, level 3 takes the home folder too", async () => {
  const repo = await mkdtemp(join(tmpdir(), "idiolect-remove-"));
  const home = join(await mkdtemp(join(tmpdir(), "idiolect-home-")), ".idiolect");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const hook = join(repo, ".git", "hooks", "pre-commit");
  await writeFile(join(repo, "CLAUDE.md"), "# Mine\n");
  await writeFile(hook, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  await mkdir(join(repo, ".idiolect", "eval"), { recursive: true });
  await writeFile(join(repo, ".idiolect", "config.json"), JSON.stringify({ styles: { kotlin: "kotlin-quiet" }, ignore: ["x/**"] }));
  await writeFile(join(repo, ".idiolect", "eval", "run.json"), "{}");
  await mkdir(home);
  await syncTargets(repo, "- rule");
  await installHook(repo, "pre-commit");
  await installHook(repo, "post-commit");

  const found = await find(repo, home);
  expect(found.blocks).toEqual([{ file: "AGENTS.md", deletes: true }, { file: "CLAUDE.md", deletes: false }]);
  expect(found.hooks.map((h) => [h.file, h.deletes])).toEqual([[".git/hooks/pre-commit", false], [".git/hooks/post-commit", true]]);
  expect(found).toMatchObject({ configKeys: ["styles"], dir: { reports: 1, decisions: false }, home });
  const listed = renderFound(repo, found, plain);
  expect(listed).toContain("the style block, your own text stays");
  expect(listed).toContain("settings, the cache, 1 eval report");
  expect(await readFile(join(repo, "CLAUDE.md"), "utf8")).toContain("idiolect:start"); // listing changes nothing
  expect(warning(found, 1)).toBeUndefined();
  expect(warning(found, 2)).toBe("This cannot be brought back: the settings in .idiolect/config.json, 1 eval report and their quiz picks.");
  expect(warning(found, 3)).toMatch(/quiz picks, your learned style, which only a new scan rebuilds\.$/);

  expect(await apply(repo, found, 1)).toEqual(["deleted  AGENTS.md", "removed  the style block from CLAUDE.md", "removed  styles from .idiolect/config.json"]);
  expect(await readFile(join(repo, "CLAUDE.md"), "utf8")).toBe("# Mine\n");
  expect(JSON.parse(await readFile(join(repo, ".idiolect", "config.json"), "utf8"))).toEqual({ ignore: ["x/**"] });

  await apply(repo, await find(repo, home), 2);
  expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
  expect((await readdir(repo)).sort()).toEqual([".git", "CLAUDE.md"]);
  expect(await readdir(join(repo, ".git", "hooks"))).not.toContain("post-commit");
  expect(await readdir(join(home, ".."))).toEqual([".idiolect"]);

  await apply(repo, await find(repo, home), 3);
  expect(await readdir(join(home, ".."))).toEqual([]);
});
