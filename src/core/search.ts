import { SearchResult, SearchConfig, DEFAULT_SEARCH_CONFIG } from "./types";
import { formatResults } from "./utils";
export function formatSearchOutput(results: SearchResult[], config: Partial<SearchConfig> = {}): string {
  const maxLen = config.maxOutputLength ?? DEFAULT_SEARCH_CONFIG.maxOutputLength;
  const f = formatResults(results);
  return f.length > maxLen ? f.slice(0, maxLen) + "\n... (truncated)" : f;
}
export function formatSearchPrompt(question: string, searchResults: string): string { return `Relevant context:\n${searchResults}\n\n${question}`; }
