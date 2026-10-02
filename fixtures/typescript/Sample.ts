import { readFile } from "node:fs/promises";

export type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; items: string[] }
  | { kind: "failed"; cause: Error };

export interface UserApi {
  fetch(id: string): Promise<User | undefined>;
}

const MAX_RETRIES = 3;
const cacheTtlMs = 60_000;

/** Users by id, cleared on logout. */
export class UserRepository {
  private readonly cache = new Map<string, User>();
  isOnline = true;

  constructor(private readonly api: UserApi) {}

  async getUser(id: string): Promise<User | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const user = await this.api.fetch(id);
      if (!user) return undefined;
      this.cache.set(id, user);
      return user;
    } catch (e) {
      // network failures are expected offline: the caller shows the cached list
      return undefined;
    }
  }

  isCached(id: string): boolean {
    return this.cache.has(id);
  }

  private evict(id: string): void {
    this.cache.delete(id);
  }
}

export const describe = (state: LoadState): string => {
  switch (state.kind) {
    case "loading": return "loading";
    case "ready": return `ready: ${state.items.length}`;
    case "failed": return `failed: ${state.cause.message}`;
  }
};

export const toSlug = (s: string): string => s.toLowerCase().replace(/ /g, "-");

function firstLine(text: string): string {
  const line = text.split("\n")[0]!;
  return line.trim();
}

export async function readConfig(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return parsed?.config ?? parsed;
}

type User = { id: string; name: string };
