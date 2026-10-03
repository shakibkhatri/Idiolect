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
    const more = createTerm(screen, { NO_COLOR: "1" }, () => clock).spinner("reading your lines");
    more.update("3/9 files");
    vi.advanceTimersByTime(120);
    expect(screen.chunks.at(-1)).toBe(`\r${ESC}[K/ reading your lines 3/9 files 0s`);
    more.stop("");
    expect(screen.chunks.at(-1)).toBe(`\r${ESC}[K`); // an empty final line leaves nothing behind
    const drawn = screen.chunks.length;
    vi.advanceTimersByTime(1000);
    expect(screen.chunks.length).toBe(drawn); // nothing is drawn after stop
  } finally {
    vi.useRealTimers();
  }
});

test("during closes the spinner with done on success and failed on an error", async () => {
  const out = fake(false);
  const t = createTerm(out, {}, () => 0);
  expect(await t.during("asking", async () => 7)).toBe(7);
  await expect(t.during("asking again", async () => { throw new Error("no"); })).rejects.toThrow("no");
  expect(out.chunks).toEqual(["asking\n", "done in 0s\n", "asking again\n", "failed after 0s\n"]);
});

const keyboard = async (isTTY = true) => {
  const { EventEmitter } = await import("node:events");
  const keys = Object.assign(new EventEmitter(), { isTTY, raw: [] as boolean[], setRawMode(on: boolean) { this.raw.push(on); }, resume() {}, pause() {} });
  const press = (name: string, text?: string) => keys.emit("keypress", text, { name });
  return { keys, press };
};

test("select moves with the arrow keys, wraps around, jumps on a digit and returns the row under Enter", async () => {
  const { select } = await import("./term.js");
  const { keys, press } = await keyboard();
  const screen = fake(true);
  const o = { input: keys, t: createTerm(screen, { NO_COLOR: "1" }), out: screen };
  const choices = [{ value: "a", label: "alpha", hint: "first" }, { value: "b", label: "be", hint: "second" }, { value: "c", label: "gamma" }];
  const picked = select(choices, o);
  expect(screen.chunks.at(-1)).toContain("> alpha - first\n");
  expect(screen.chunks.at(-1)).toContain("  be    - second\n");
  press("up"); // wraps to the last row
  expect(screen.chunks.at(-1)).toContain("> gamma\n");
  press("2", "2");
  press("down");
  press("x", "x"); // an unknown key changes nothing
  press("escape"); // nothing to leave to, so it is ignored
  press("return");
  expect(await picked).toBe("c");
  expect(keys.raw).toEqual([true, false]);
  expect(screen.chunks.at(-1)).toContain(`${ESC}[?25h`); // the cursor is shown again

  // numbered rows and a leave row: Enter on Leave and Esc both answer nothing
  const leaving = select(choices, { ...o, numbered: true, leave: "Leave", start: 3 });
  expect(screen.chunks.at(-1)).toContain("  1  alpha - first\n");
  expect(screen.chunks.at(-1)).toContain(">    Leave\n");
  expect(screen.chunks.at(-1)).toContain("Enter to choose, Esc to leave");
  press("return");
  expect(await leaving).toBeUndefined();
  const escaped = select(choices, { ...o, leave: "Leave" });
  press("escape");
  expect(await escaped).toBeUndefined();
  const first = select(choices, { ...o, numbered: true, leave: "Leave", start: 3 });
  press("down"); // from Leave it wraps to the first row
  press("return");
  expect(await first).toBe("a");

  // without a terminal there is no list, the caller asks for a typed answer
  expect(await select(choices, { ...o, input: (await keyboard(false)).keys })).toBeUndefined();
  expect(await select(choices, { ...o, t: createTerm(fake(false), {}) })).toBeUndefined();
});

test("multiSelect ticks with Space, keeps one tick per group and answers at once on an instant row", async () => {
  const { multiSelect } = await import("./term.js");
  const { keys, press } = await keyboard();
  const screen = fake(true);
  const o = { input: keys, t: createTerm(screen, { NO_COLOR: "1" }), out: screen, numbered: true };
  const rows = [
    { value: "k1", label: "kotlin-quiet", hint: "few comments", heading: "Kotlin", group: "kotlin" },
    { value: "k2", label: "kotlin-other", group: "kotlin" },
    { value: "t1", label: "typescript-terse", heading: "TypeScript", group: "typescript" },
    { value: "more", label: "Show 2 more styles", heading: "Other languages", instant: true },
  ];
  const picked = multiSelect(rows, ["k1", "t1"], o);
  expect(screen.chunks.at(-1)).toContain("Kotlin\n");
  expect(screen.chunks.at(-1)).toContain("> [x] 1  kotlin-quiet - few comments\n");
  expect(screen.chunks.at(-1)).toContain("  [ ] 2  kotlin-other\n");
  expect(screen.chunks.at(-1)).toContain("Space to tick, Enter to confirm, Esc to leave");
  press("down");
  press("space", " "); // ticking the second Kotlin style unticks the first
  expect(screen.chunks.at(-1)).toContain("  [ ] 1  kotlin-quiet");
  expect(screen.chunks.at(-1)).toContain("> [x] 2  kotlin-other");
  press("3", "3");
  press("space", " "); // unticks TypeScript
  press("return");
  expect(await picked).toEqual(["k2"]);

  const more = multiSelect(rows, ["k1"], o);
  press("4", "4");
  press("space", " ");
  expect(await more).toEqual(["more"]);
  const left = multiSelect(rows, ["k1"], o);
  press("escape");
  expect(await left).toBeUndefined();
});
