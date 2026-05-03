import { SearchResult, SearchConfig, DEFAULT_SEARCH_CONFIG } from "./types";
import { packSearchResults } from "./context-packer";
export function formatSearchOutput(results: SearchResult[], config: Partial<SearchConfig> = {}): string {
  const maxLen = config.maxOutputLength ?? DEFAULT_SEARCH_CONFIG.maxOutputLength;
  return packSearchResults(results, { maxTotalChars: maxLen }).output;
}
export function formatSearchPrompt(question: string, searchResults: string): string { return `Relevant context:\n${searchResults}\n\n${question}`; }
