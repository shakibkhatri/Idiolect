import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureRepoDir, loadRepoConfig, loadUserConfig, repoConfigPath } from "./config.js";
import { loadProfile, profilePath, type Profile, type Rule } from "./profile.js";
import { composeStyles } from "./styles.js";

type Override = { status: "approved" | "rejected" | "edited"; text?: string };
const overridesPath = (repo: string) => join(repo, ".idiolect", "overrides.json");

/**
 * The profile a repo serves. Shipped styles picked in its config come first, then the profile `profile` names,
 * then the developer's own. Anything but the developer's own is borrowed.
 */
export async function loadServedProfile(repo?: string): Promise<Profile | undefined> {
  const config = repo ? await loadRepoConfig(repo) : undefined;
  if (config?.styles && Object.values(config.styles).some(Boolean)) {
    const profile = await composeStyles(config.styles);
    const overrides = JSON.parse(await readFile(overridesPath(repo!), "utf8").catch(() => "{}")) as Record<string, Override>;
    const rules = profile.rules.map((r): Rule => (overrides[r.id] ? { ...r, status: overrides[r.id]!.status, text: overrides[r.id]!.text ?? r.text } : r));
    return { ...profile, rules, borrowed: config.borrow };
  }
  const named = config?.profile;
  const user = await loadUserConfig();
  if (!named) return user && loadProfile(user.emails[0]!);
  const profile = await loadProfile(named);
  if (!profile) throw new Error(`no stored style at ${profilePath(named)}, named by "profile" in ${repoConfigPath(repo!)}`);
  // someone else's profile is borrowed: only the kinds the repo asks for, never its project rules
  const own = user?.emails.some((e) => e.toLowerCase() === named.toLowerCase());
  return own ? profile : { ...profile, borrowed: config!.borrow };
}

/** A shipped style cannot be edited in place, so the decisions made on it in a repo are kept in that repo. */
export async function saveOverrides(repo: string, profile: Profile) {
  const overrides: Record<string, Override> = {};
  for (const r of profile.rules) if (r.status === "approved" || r.status === "rejected" || r.status === "edited") overrides[r.id] = { status: r.status, ...(r.status === "edited" ? { text: r.text } : {}) };
  await mkdir(await ensureRepoDir(repo), { recursive: true });
  await writeFile(overridesPath(repo), JSON.stringify(overrides, null, 2) + "\n");
}
