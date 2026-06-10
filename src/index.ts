export { OpenContext } from "./core/context";
export { FileWatcher } from "./core/file-watcher";
export { liveIndex, createLiveContext } from "./core/live-index";
export type { LiveIndexOptions, LiveIndexHandle } from "./core/live-index";
export { CodeChunker } from "./core/chunker";
export { FileFilter } from "./core/file-filter";
export { SqliteStore, NativeBindingError } from "./core/sqlite-store";
export { classifyNativeBindingError, diagnosisOneLiner } from "./core/native-binding-error";
export type { NativeBindingDiagnosis, NativeBindingErrorKind } from "./core/native-binding-error";
export { HybridRetriever, reciprocalRankFusion } from "./core/retriever";
export { createReranker, VoyageReranker, CohereReranker } from "./core/reranker";
export type { Reranker } from "./core/reranker";
export { ContextAgent, defaultCodebaseTools, defaultAgentTools, FsEditApplier, editTools } from "./agent/agent";
export type { AgentConfig, AgentMessage, AgentRunOptions, LLMProvider, ToolCall, ToolDefinition, StreamEvent, EditProposal } from "./agent/types";
export type { EditApplier } from "./agent/edit-tools";
export { unifiedDiff } from "./core/diff";
export { createMCPServer, runMCPServer } from "./mcp/server";
export type { RunMCPServerOptions } from "./mcp/server";
export type { File, Chunk, SearchResult, IndexingResult, OpenContextState, OpenContextConfig, EmbeddingConfig, SearchConfig, RerankerConfig, FreshnessReport, GitState, IndexMetadata } from "./core/types";
export { OpenAIEmbeddingProvider, VoyageEmbeddingProvider, OllamaEmbeddingProvider, createEmbeddingProvider } from "./core/embedder";
export { getFileRecencyScores, applyRecencyBoost } from "./core/git-recency";
export type { RecencyScores } from "./core/git-recency";
export { expandQuery } from "./core/query-expander";
export type { ExpandedQuery } from "./core/query-expander";
export { QueryCache } from "./core/query-cache";
export { loadGuidelines, getRelevantGuidelines } from "./core/guidelines";
export type { Guidelines, GuidelineSection } from "./core/guidelines";
export { StepBudget } from "./agent/step-budget";
export { CodeGraph } from "./core/code-graph";
export type { GraphEdge, EdgeKind } from "./core/code-graph";
export { extractEdgesFromSource } from "./core/graph-extractor";
export { GraphExpander } from "./core/graph-expander";
export { packWithDependencies } from "./core/dependency-packer";
export { MultiContext } from "./core/multi-context";
export { StreamingRetriever } from "./core/streaming-retriever";
export type { StreamingResult } from "./core/streaming-retriever";
export { ModelRouter } from "./agent/model-router";
export type { ModelTier, RoutingConfig } from "./agent/model-router";
export { SessionMemory } from "./agent/session-memory";
export type { MemoryEntry, MemoryKind } from "./agent/session-memory";
export {
  getLicense, verifyLicenseToken, isEntitled, requireFeature, loadEnterpriseEdition,
  saveLicenseToken, loadLicenseToken, clearLicense, licenseConfigPath, licenseConfigDir,
  serializeLicensePayload, DEFAULT_GRACE_DAYS,
} from "./core/license";
export type { Plan, Feature, LicensePayload, LicenseStatus, LicenseReason, VerifyOptions } from "./core/license";
