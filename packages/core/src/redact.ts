// Strips things that look like secrets before any text leaves the machine.
const PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,                       // openai / stripe style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,                           // anthropic
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                               // google api keys
  /\bAKIA[0-9A-Z]{16}\b/g,                                    // aws access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                          // github tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                        // slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // jwt
  /(bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,                     // bearer tokens
  /((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?)[^\s"',;)]{6,}/gi, // key = value
  /(\/\/[^\s/:]+:)[^\s@/]+(@)/g,                              // credentials in urls
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (...args) => {
    const caps = args.slice(1, -2) as (string | undefined)[]; // trailing args are offset and input
    return `${caps[0] ?? ""}[REDACTED]${caps[1] ?? ""}`;
  });
  return out;
}
