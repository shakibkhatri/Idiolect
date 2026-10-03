import { term, type Term } from "./term.js";

export const TAGLINE = "Give your AI coding agent a style to write in: your own, or a house style";

/** The top-level help, grouped by who needs the command. One line per command, at most 80 columns. */
const GROUPS: { title: string; commands: [name: string, text: string][] }[] = [
  { title: "Get a style", commands: [
    ["use", "pick a house style for this project"],
    ["init", "set up learning your own style from your git history"],
    ["scan", "learn or update your own style"],
    ["sync", "write the style into your agent's instruction files"],
    ["remove", "take idiolect out of this project again"],
  ] },
  { title: "Review and check", commands: [
    ["show", "print the style your agent reads"],
    ["rules", "approve, reject or edit rules"],
    ["ui", "do the same in the browser"],
    ["unbot", "flag code that breaks the style or sounds like AI"],
    ["styles", "list the house styles"],
  ] },
];
const ADVANCED = ["mcp", "hooks", "status", "refresh", "eval"];

/** A command registered but not grouped above lands under Advanced, so none can go missing from the help. */
export function renderHelp(registered: string[], t: Term = term): string {
  const grouped = new Set([...GROUPS.flatMap((g) => g.commands.map(([name]) => name)), ...ADVANCED, "help"]);
  const advanced = [...ADVANCED, ...registered.filter((name) => !grouped.has(name))];
  const width = Math.max(...GROUPS.flatMap((g) => g.commands.map(([name]) => name.length)));
  return [
    "Usage: idiolect [command] [options]", "",
    TAGLINE, "",
    ...GROUPS.flatMap((g) => [t.bold(g.title), ...g.commands.map(([name, text]) => `  ${t.accent(name.padEnd(width))}   ${text}`), ""]),
    t.bold("Advanced"), `  ${advanced.join(", ")}`, "",
    t.dim("idiolect alone shows where this project stands and asks what to do next,"),
    t.dim("--no-prompt only shows it. idiolect help <command> explains one command."),
    t.dim("idiolect --version prints the version."),
  ].join("\n") + "\n";
}
