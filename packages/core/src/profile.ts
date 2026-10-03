import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeCommits, emptyStats, mergeStats, type CommitStats, type LanguageStats } from "./analyzer.js";
import type { Spread } from "./metrics.js";
import type { Commit } from "./collector.js";
import { loadRepoConfig, loadUserConfig, repoConfigPath } from "./config.js";

export type Language = "kotlin" | "typescript" | "python" | "go";

/** Voice does not age, layout is what a formatter decides, idiom depends on the language version the code was written against. */
export type RuleKind = "voice" | "layout" | "idiom";

export type Rule = {
  id: string;
  scope: "personal" | "team";
  language: Language | "any";
  category: "naming" | "comments" | "structure" | "errors" | "framework" | "commits" | "avoid";
  text: string;
  evidence: { metric?: { name: string; value: number; sampleSize: number }; examples: { file: string; line: number; snippet: string }[]; count?: number };
  confidence: number;
  status: "auto" | "pending" | "approved" | "rejected" | "edited";
  previousText?: string; // the approved text a rescan replaced, kept while the rule is pending
  kind?: RuleKind;      // set on LLM rules, metric rules derive it, see ruleKind
  paths?: string[];
  learnedIn?: string;   // repo path the examples came from (LLM rules)
  repo?: string;        // set when the rule is a project convention: served only inside this repo
};

export type Source = { repo: string; head: string; headDate?: string; scannedAt: string; commits: number; linesOwned: number; stats: Partial<Record<Language, LanguageStats>>; commitStats: CommitStats; spread?: Partial<Record<Language, Record<string, Spread>>> };

export type Profile = {
  version: 1;
  developer: { name: string; emails: string[] };
  generatedAt: string;
  sources: Source[];
  stats: Partial<Record<Language, LanguageStats>>;
  commitStats: CommitStats;
  rules: Rule[];
  borrowed?: RuleKind[]; // in memory only: the kinds a repo serves from someone else's profile
};

const IDIOM_METRIC = /^(kotlin|typescript|python|go)\.|^errors\.run-catching-share$|^functions\.expression-body-ratio$/;

/** Rules written before kinds existed fall back on their metric, then on their category. */
export function ruleKind(r: Rule): RuleKind {
  if (r.kind) return r.kind;
  if (r.category === "avoid") return "voice";
  if (r.evidence.metric) return IDIOM_METRIC.test(r.evidence.metric.name) ? "idiom" : "voice";
  return r.category === "structure" || r.category === "errors" || r.category === "framework" ? "idiom" : "voice";
}

export const profileDir = () => join(homedir(), ".idiolect", "profiles");
export const profilePath = (email: string) => join(profileDir(), `${email.toLowerCase()}.json`);

export function emptyProfile(name: string, emails: string[]): Profile {
  return { version: 1, developer: { name, emails }, generatedAt: new Date().toISOString(), sources: [], stats: {}, commitStats: analyzeCommits([]), rules: [] };
}

export async function loadProfile(email: string): Promise<Profile | undefined> {
  const raw = await readFile(profilePath(email), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const profile = JSON.parse(raw) as Profile;
  // stats written before a language or counter existed get the zero shape, so metrics never see undefined
  const fill = (stats: Partial<Record<Language, LanguageStats>>) => Object.fromEntries(Object.entries(stats).map(([l, st]) => [l, mergeStats(emptyStats(), st!)]));
  return { ...profile, stats: fill(profile.stats), sources: profile.sources.map((s) => ({ ...s, stats: fill(s.stats) })) };
}

/** The profile a repo serves: the one `profile` names in its config, otherwise the developer's own. */
export async function loadServedProfile(repo?: string): Promise<Profile | undefined> {
  const config = repo ? await loadRepoConfig(repo) : undefined;
  const named = config?.profile;
  const user = await loadUserConfig();
  if (!named) return user && loadProfile(user.emails[0]!);
  const profile = await loadProfile(named);
  if (!profile) throw new Error(`no profile ${profilePath(named)}, named by "profile" in ${repoConfigPath(repo!)}`);
  // someone else's profile is borrowed: only the kinds the repo asks for, never its project rules
  const own = user?.emails.some((e) => e.toLowerCase() === named.toLowerCase());
  return own ? profile : { ...profile, borrowed: config!.borrow };
}

export async function saveProfile(profile: Profile) {
  await mkdir(profileDir(), { recursive: true });
  const { borrowed: _transient, ...stored } = profile;
  await writeFile(profilePath(profile.developer.emails[0]!), JSON.stringify(stored, null, 2) + "\n");
}

/** Replaces the entry for `source.repo` and recomputes merged stats from all sources. */
export function upsertSource(profile: Profile, source: Source): Profile {
  const sources = [...profile.sources.filter((s) => s.repo !== source.repo), source];
  const stats: Partial<Record<Language, LanguageStats>> = {};
  let commitStats = analyzeCommits([]);
  for (const s of sources) {
    for (const [lang, st] of Object.entries(s.stats) as [Language, LanguageStats][]) stats[lang] = mergeStats(stats[lang] ?? emptyStats(), st);
    commitStats = mergeStats(commitStats, s.commitStats);
  }
  const emails = [...new Set([...profile.developer.emails])];
  return { ...profile, developer: { ...profile.developer, emails }, generatedAt: new Date().toISOString(), sources, stats, commitStats };
}

export const commitsToStats = (commits: Commit[]) => analyzeCommits(commits);

/** Sets a decision on rules by id. `edit` needs `text`, the other statuses keep the current text. Unknown ids throw. */
export function updateRules(profile: Profile, ids: string[], status: "approved" | "rejected" | "edited", text?: string): Profile {
  const known = new Set(profile.rules.map((r) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new Error(`no rule ${missing.join(", ")}, see: idiolect rules list`);
  if (status === "edited" && !text?.trim()) throw new Error("edit needs the new rule text");
  const rules = profile.rules.map((r) => (ids.includes(r.id) ? { ...r, status, previousText: undefined, ...(status === "edited" ? { text: text!.trim() } : {}) } : r));
  return { ...profile, rules };
}
