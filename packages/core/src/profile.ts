import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeCommits, emptyStats, mergeStats, type CommitStats, type LanguageStats } from "./analyzer.js";
import type { Commit } from "./collector.js";

export type Language = "kotlin";

export type Rule = {
  id: string;
  scope: "personal" | "team";
  language: Language | "any";
  category: "naming" | "comments" | "structure" | "errors" | "framework" | "commits" | "avoid";
  text: string;
  evidence: { metric?: { name: string; value: number; sampleSize: number }; examples: { file: string; line: number; snippet: string }[]; count?: number };
  confidence: number;
  status: "auto" | "pending" | "approved" | "rejected" | "edited";
  paths?: string[];
};

export type Source = { repo: string; head: string; scannedAt: string; commits: number; linesOwned: number; stats: Partial<Record<Language, LanguageStats>>; commitStats: CommitStats };

export type Profile = {
  version: 1;
  developer: { name: string; emails: string[] };
  generatedAt: string;
  sources: Source[];
  stats: Partial<Record<Language, LanguageStats>>;
  commitStats: CommitStats;
  rules: Rule[];
};

export const profileDir = () => join(homedir(), ".idiolect", "profiles");
export const profilePath = (email: string) => join(profileDir(), `${email.toLowerCase()}.json`);

export function emptyProfile(name: string, emails: string[]): Profile {
  return { version: 1, developer: { name, emails }, generatedAt: new Date().toISOString(), sources: [], stats: {}, commitStats: analyzeCommits([]), rules: [] };
}

export async function loadProfile(email: string): Promise<Profile | undefined> {
  const raw = await readFile(profilePath(email), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : (JSON.parse(raw) as Profile);
}

export async function saveProfile(profile: Profile) {
  await mkdir(profileDir(), { recursive: true });
  await writeFile(profilePath(profile.developer.emails[0]!), JSON.stringify(profile, null, 2) + "\n");
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
