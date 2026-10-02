import { analyzeKotlin, type AnalyzeOptions, type LanguageStats } from "./analyzer.js";
import { analyzeGo } from "./analyzer-go.js";
import { analyzePython } from "./analyzer-py.js";
import { analyzeTypeScript } from "./analyzer-ts.js";
import type { LineRange } from "./collector.js";
import type { Language } from "./profile.js";

const ANALYZERS: Record<Language, (code: string, owned?: LineRange[], opts?: AnalyzeOptions) => Promise<LanguageStats>> = { kotlin: analyzeKotlin, typescript: analyzeTypeScript, python: analyzePython, go: analyzeGo };

export const analyze = (code: string, lang: Language, owned?: LineRange[], opts: AnalyzeOptions = {}) => ANALYZERS[lang](code, owned, opts);
