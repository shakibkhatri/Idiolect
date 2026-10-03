import { expect, test, vi } from "vitest";
import { createTerm } from "./term.js";

const ESC = "\x1b";
const fake = (isTTY: boolean) => {
  const chunks: string[] = [];
  return { isTTY, chunks, write: (text: string) => chunks.push(text) };
};

test("a pipe gets plain text and a fake TTY gets colour, unless NO_COLOR is set", () => {
  const pipe = createTerm(fake(false), {});
  expect(pipe.ok("done")).toBe("done");
  expect(pipe.color).toBe(false);

  const tty = createTerm(fake(true), {});
  expect(tty.ok("done")).toBe(`${ESC}[32mdone${ESC}[39m`);
  expect(tty.dim("id")).toBe(`${ESC}[2mid${ESC}[22m`);
  expect(tty.interactive).toBe(true);

  const quiet = createTerm(fake(true), { NO_COLOR: "1" });
  expect(quiet.bad("no")).toBe("no");
  expect(quiet.interactive).toBe(true);
  expect(createTerm(fake(true), { NO_COLOR: "" }).color).toBe(true); // an empty NO_COLOR does not count
});

test("the spinner prints two stable lines in a pipe and redraws one line in a TTY", () => {
  vi.useFakeTimers();
  try {
    let clock = 0;
    const out = fake(false);
    const piped = createTerm(out, {}, () => clock).spinner("asking claude-cli");
    clock = 84_000;
    vi.advanceTimersByTime(1000);
    piped.stop();
    expect(out.chunks).toEqual(["asking claude-cli\n", "done in 84s\n"]);
    expect(out.chunks.join("")).not.toContain(ESC);

    clock = 0;
    const screen = fake(true);
    const live = createTerm(screen, { NO_COLOR: "1" }, () => clock).spinner("asking claude-cli");
    clock = 2000;
    vi.advanceTimersByTime(240);
    live.stop();
    expect(screen.chunks[0]).toBe(`\r${ESC}[K| asking claude-cli 0s`);
    expect(screen.chunks[1]).toBe(`\r${ESC}[K/ asking claude-cli 2s`);
    expect(screen.chunks.at(-1)).toBe(`\r${ESC}[Kasking claude-cli done in 2s\n`);
    const drawn = screen.chunks.length;
    vi.advanceTimersByTime(1000);
    expect(screen.chunks.length).toBe(drawn); // nothing is drawn after stop
  } finally {
    vi.useRealTimers();
  }
});
