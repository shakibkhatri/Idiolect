import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { installHook } from "./unbot.js";

test("installHook creates, appends once, and prefers .husky", async () => {
  const repo = await mkdtemp(join(tmpdir(), "idiolect-hook-"));
  await promisify(execFile)("git", ["init", "-q", repo]);
  expect(await installHook(repo, "pre-commit")).toBe("created .git/hooks/pre-commit");
  expect(await installHook(repo, "pre-commit")).toBe("already installed in .git/hooks/pre-commit");
  await writeFile(join(repo, ".git/hooks/post-commit"), "#!/bin/sh\necho mine\n");
  expect(await installHook(repo, "post-commit")).toBe("appended to .git/hooks/post-commit");
  expect(await readFile(join(repo, ".git/hooks/post-commit"), "utf8")).toMatch(/^#!\/bin\/sh\necho mine\n\n# idiolect:.*\nidiolect refresh\n$/);
  await mkdir(join(repo, ".husky"));
  await writeFile(join(repo, ".husky/pre-commit"), "pnpm lint\n");
  expect(await installHook(repo, "pre-commit")).toBe("appended to .husky/pre-commit");
  await writeFile(join(repo, "lefthook.yml"), "");
  expect(await installHook(repo, "post-commit")).toMatch(/^lefthook.yml found/);
});
