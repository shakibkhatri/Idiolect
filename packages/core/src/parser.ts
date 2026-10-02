import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

// add a wasm to grammars/ and a row to scripts/update-grammars.sh per grammar
export type SupportedLanguage = "kotlin" | "typescript" | "tsx";

const languages = new Map<SupportedLanguage, Language>();
let initialized: Promise<void> | undefined;

async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  initialized ??= Parser.init();
  await initialized;
  let loaded = languages.get(lang);
  if (!loaded) {
    loaded = await Language.load(fileURLToPath(new URL(`../grammars/${lang}.wasm`, import.meta.url)));
    languages.set(lang, loaded);
  }
  return loaded;
}

export async function parse(code: string, lang: SupportedLanguage): Promise<Tree> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(code);
  parser.delete();
  if (!tree) throw new Error(`tree-sitter returned no tree for ${lang}`);
  return tree;
}
