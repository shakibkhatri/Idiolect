/** Colour, spinner and the TTY check for every command, so none of them writes ANSI codes itself. */
export type Out = { isTTY?: boolean; write(text: string): unknown };
type Env = Record<string, string | undefined>;

// The roles of theme.ts on the basic ANSI colours, which follow the user's terminal theme.
const CODES = { bold: 1, dim: 2, accent: 36, ok: 32, warn: 33, bad: 31 } as const;
const FRAMES = ["|", "/", "-", "\\"];
const FRAME_MS = 120;

export type Paint = (text: string) => string;
export type Spinner = { stop(final?: string): void };
export type Term = Record<keyof typeof CODES, Paint> & { interactive: boolean; color: boolean; spinner(label: string): Spinner };

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
      return { stop: (final) => void stream.write(`${final ?? `done in ${seconds()}`}\n`) };
    }
    let frame = 0;
    const draw = () => void stream.write(`\r\x1b[K${paints.accent(FRAMES[frame++ % FRAMES.length]!)} ${label} ${paints.dim(seconds())}`);
    draw();
    const timer = setInterval(draw, FRAME_MS);
    timer.unref();
    return {
      stop: (final) => {
        clearInterval(timer);
        stream.write(`\r\x1b[K${final ?? `${label} ${paints.dim(`done in ${seconds()}`)}`}\n`);
      },
    };
  };

  return { ...paints, interactive, color, spinner };
}

export const term = createTerm();
