import { expect, test } from "vitest";
import { renderHelp } from "./help.js";
import { createTerm } from "./term.js";

const plain = createTerm({ isTTY: false, write: () => 0 }, {});

test("the help shows three groups within 80 columns and never loses a registered command", () => {
  const help = renderHelp(["init", "scan", "use", "mcp", "brand-new"], plain);
  const lines = help.split("\n");
  expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(80);
  for (const title of ["Get a style", "Review and check", "Advanced"]) expect(lines).toContain(title);
  expect(lines).toContain("  use      pick a house style for this project");
  expect(lines).toContain("  mcp, hooks, status, refresh, eval, brand-new");
  expect(help).not.toMatch(/profile|shipped|build/);
  expect(lines).toContain("  remove   take idiolect out of this project again");
});
