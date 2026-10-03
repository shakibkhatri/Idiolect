import { ensureRepoDir, git, loadProfile, loadRepoConfig, loadUserConfig, userConfigPath, type Profile } from "@shakibkhatri/idiolect-core";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join, resolve } from "node:path";

async function load() {
  const user = await loadUserConfig();
  if (!user) throw new Error(`no ${userConfigPath()}, run: idiolect init`);
  const profile = await loadProfile(user.emails[0]!);
  if (!profile) throw new Error("you have no style of your own yet, run: idiolect scan");
  return profile;
}

/** Commits on HEAD since the last scan of this repo, or undefined when the repo was never scanned. */
export async function commitsSince(profile: Profile, repo: string): Promise<{ since: number; scannedAt: string } | undefined> {
  const source = profile.sources.find((s) => s.repo === repo);
  if (!source) return undefined;
  const since = Number((await git(repo, ["rev-list", "--count", `${source.head}..HEAD`]).catch(() => "0")).trim());
  return { since, scannedAt: source.scannedAt };
}

export const ago = (iso: string) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3600000);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
};

export function refreshCommand(): Command {
  return new Command("refresh").description("rescan in the background once refresh.everyCommits new commits have landed. Quiet otherwise, for the post-commit hook")
    .option("--repo <path>", "repository path", ".")
    .option("--force", "rescan now regardless of the count")
    .action(async (o: { repo: string; force?: boolean }) => {
      const repo = (await git(resolve(o.repo), ["rev-parse", "--show-toplevel"])).trim();
      const profile = await load();
      const { refresh } = await loadRepoConfig(repo);
      const s = await commitsSince(profile, repo);
      if (!o.force && (!s || s.since < refresh.everyCommits)) return;
      const log = join(await ensureRepoDir(repo), "cache", "refresh.log");
      const fd = openSync(log, "a");
      // the hook must return at once, so the scan runs detached and logs to the cache dir
      const child = spawn(process.execPath, [process.argv[1]!, "scan", "--repo", repo], { detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      console.log(`idiolect: ${s ? `${s.since} commits since the last scan, ` : ""}rescanning in the background, log in ${log}`);
    });
}
