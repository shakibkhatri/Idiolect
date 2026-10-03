import { emitKeypressEvents } from "node:readline";

/** Colour, spinner, the arrow-key list and the TTY check for every command, so none of them writes ANSI codes itself. */
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

/** A heading is printed above the row. Rows of one group untick each other. An instant row answers alone the moment it is ticked. */
export type Choice<T> = { value: T; label: string; hint?: string; heading?: string; group?: string; instant?: boolean };
type KeyHandler = (text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => void;
export type Keys = { isTTY?: boolean; setRawMode?(raw: boolean): unknown; resume(): unknown; pause(): unknown; on(event: "keypress", fn: KeyHandler): unknown; off(event: "keypress", fn: KeyHandler): unknown };
export type ListOptions = { start?: number; numbered?: boolean; leave?: string; input?: Keys; t?: Term; out?: Out };

/** A list needs a terminal on both ends. Without one the caller prints the options and reads a typed answer. */
export const canAsk = (input: Keys = process.stdin, t: Term = term) => input.isTTY === true && !!input.setRawMode && t.interactive;

// one engine for both lists: `ticked` is undefined for a single choice and the set of ticked rows for a checklist
function list<T>(choices: Choice<T>[], o: ListOptions, ticked?: Set<number>): Promise<number[] | undefined> {
  const input = o.input ?? process.stdin, t = o.t ?? term, out = o.out ?? process.stdout;
  if (!canAsk(input, t)) return Promise.resolve(undefined);
  const rows = choices.length + (o.leave ? 1 : 0);
  // only rows with a hint line up, a long label without one must not push the dashes out
  const width = Math.max(0, ...choices.filter((c) => c.hint).map((c) => c.label.length));
  const digits = String(choices.length).length;
  let at = Math.min(Math.max(o.start ?? 0, 0), rows - 1);
  const mark = (i: number, text: string) => (i === at ? `${t.accent(">")} ${t.bold(text)}` : `  ${text}`);
  const render = () => {
    const lines: string[] = [];
    choices.forEach((c, i) => {
      if (c.heading !== undefined) lines.push(...(i ? [""] : []), c.heading);
      const box = !ticked ? "" : c.instant ? "    " : ticked.has(i) ? "[x] " : "[ ] ";
      const number = o.numbered ? `${String(i + 1).padStart(digits)}  ` : "";
      lines.push(mark(i, `${box}${number}${c.hint ? `${c.label.padEnd(width)} - ${c.hint}` : c.label}`));
    });
    if (o.leave) lines.push(mark(choices.length, `${" ".repeat((ticked ? 4 : 0) + (o.numbered ? digits + 2 : 0))}${o.leave}`));
    lines.push(t.dim(ticked ? "Up and down to move, Space to tick, Enter to confirm, Esc to leave" : `Up and down to move, Enter to choose${o.leave ? ", Esc to leave" : ""}`));
    return lines;
  };
  const height = render().length;
  const draw = (first: boolean) => out.write(`${first ? "" : `\x1b[${height}A`}${render().map((l) => `\x1b[2K${l}\n`).join("")}`);
  return new Promise((done) => {
    const finish = (picked: number[] | undefined) => {
      input.off("keypress", onKey);
      input.setRawMode!(false);
      input.pause();
      // the key help goes, the list stays as it was answered
      out.write("\x1b[1A\x1b[2K\x1b[?25h");
      done(picked);
    };
    const tick = () => {
      const c = choices[at];
      if (!ticked || !c) return;
      if (c.instant) return finish([at]);
      if (ticked.has(at)) ticked.delete(at);
      else {
        if (c.group) choices.forEach((other, i) => { if (other.group === c.group) ticked.delete(i); });
        ticked.add(at);
      }
      draw(false);
    };
    const onKey: KeyHandler = (text, key) => {
      if (key?.ctrl && key.name === "c") { finish(undefined); process.exit(130); }
      if (key?.name === "escape") { if (ticked || o.leave) finish(undefined); return; }
      if (key?.name === "return" || key?.name === "enter") {
        if (ticked) return choices[at]?.instant ? finish([at]) : finish([...ticked].sort((a, b) => a - b));
        return finish(at < choices.length ? [at] : undefined);
      }
      if (key?.name === "space") return tick();
      const digit = text && /^[0-9]+$/.test(text) ? Number(text) - 1 : -1;
      if (key?.name === "up" || key?.name === "k") at = (at + rows - 1) % rows;
      else if (key?.name === "down" || key?.name === "j") at = (at + 1) % rows;
      else if (digit >= 0 && digit < choices.length) at = digit;
      else return;
      draw(false);
    };
    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    input.setRawMode!(true);
    input.resume();
    out.write("\x1b[?25l");
    draw(true);
    input.on("keypress", onKey);
  });
}

/** One row is chosen with the arrow keys and Enter, a digit jumps to its row. Undefined when the user leaves or there is no terminal. */
export async function select<T>(choices: Choice<T>[], o: ListOptions = {}): Promise<T | undefined> {
  const picked = await list(choices, o);
  return picked?.length ? choices[picked[0]!]!.value : undefined;
}

/** A checklist: Space ticks, Enter confirms what is ticked. Undefined when the user leaves or there is no terminal. */
export async function multiSelect<T>(choices: Choice<T>[], ticked: T[] = [], o: ListOptions = {}): Promise<T[] | undefined> {
  const picked = await list(choices, o, new Set(choices.flatMap((c, i) => (ticked.includes(c.value) ? [i] : []))));
  return picked?.map((i) => choices[i]!.value);
}
