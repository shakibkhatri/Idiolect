/** Colour, spinner and the TTY check for every command, so none of them writes ANSI codes itself. */
export type Out = { isTTY?: boolean; write(text: string): unknown };
type Env = Record<string, string | undefined>;

// The roles of theme.ts on the basic ANSI colours, which follow the user's terminal theme.
const CODES = { bold: 1, dim: 2, accent: 36, ok: 32, warn: 33, bad: 31 } as const;
const FRAMES = ["|", "/", "-", "\\"];
const FRAME_MS = 120;

export type Paint = (text: string) => string;
/** update sets the detail after the label, clear makes room for a line of output, stop("") leaves no line behind. */
export type Spinner = { update(detail: string): void; clear(): void; stop(final?: string): void; fail(): void };
export type Term = Record<keyof typeof CODES, Paint> & { interactive: boolean; color: boolean; spinner(label: string): Spinner; during<T>(label: string, work: (s: Spinner) => Promise<T>): Promise<T> };

export function isInteractive(stream: Out = process.stdout): boolean {
  return stream.isTTY === true;
}

export function createTerm(stream: Out = process.stdout, env: Env = process.env, now: () => number = Date.now): Term {
  const interactive = isInteractive(stream);
  const color = interactive && !env.NO_COLOR;
  const paint = (code: number): Paint => (text) => (color ? `\x1b[${code}m${text}\x1b[${code === 1 || code === 2 ? 22 : 39}m` : text);
  const paints = Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, paint(code)])) as Record<keyof typeof CODES, Paint>;

  /** A TTY redraws one line with the elapsed seconds, a pipe gets the label once and "done in Ns". */
  const spinner = (label: string): Spinner => {
    const started = now();
    const seconds = () => `${Math.round((now() - started) / 1000)}s`;
    if (!interactive) {
      stream.write(`${label}\n`);
      const end = (line: string) => void (line && stream.write(`${line}\n`));
      return { update: () => {}, clear: () => {}, stop: (final) => end(final ?? `done in ${seconds()}`), fail: () => end(`failed after ${seconds()}`) };
    }
    let frame = 0, detail = "";
    const draw = () => void stream.write(`\r\x1b[K${paints.accent(FRAMES[frame++ % FRAMES.length]!)} ${label}${detail ? ` ${detail}` : ""} ${paints.dim(seconds())}`);
    draw();
    const timer = setInterval(draw, FRAME_MS);
    timer.unref();
    const end = (line: string) => {
      clearInterval(timer);
      stream.write(`\r\x1b[K${line ? `${line}\n` : ""}`);
    };
    return {
      update: (text) => { detail = text; },
      clear: () => void stream.write("\r\x1b[K"),
      stop: (final) => end(final ?? `${label} ${paints.dim(`done in ${seconds()}`)}`),
      fail: () => end(`${label} ${paints.bad(`failed after ${seconds()}`)}`),
    };
  };

  /** Runs the work under a spinner and closes it with done or failed. */
  const during = async <T>(label: string, work: (s: Spinner) => Promise<T>): Promise<T> => {
    const s = spinner(label);
    try { const result = await work(s); s.stop(); return result; } catch (e) { s.fail(); throw e; }
  };

  return { ...paints, interactive, color, spinner, during };
}

export const term = createTerm();
// progress goes to stderr, so a piped stdout holds only the result
export const progress = createTerm(process.stderr);
