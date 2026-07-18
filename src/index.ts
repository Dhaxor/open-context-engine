export { OpenContext } from "./core/context";
export { FileWatcher } from "./core/file-watcher";
export { runEval, parseEvalCases, compareReports } from "./eval/runner";
export type { EvalCase, EvalCaseResult, EvalReport, EvalComparison, SearchFn } from "./eval/runner";
export { computeCaseMetrics, aggregate as aggregateEvalMetrics, dedupeRanked } from "./eval/metrics";
export type { CaseMetrics, AggregateMetrics } from "./eval/metrics";
export { liveIndex, createLiveContext } from "./core/live-index";
export type { LiveIndexOptions, LiveIndexHandle } from "./core/live-index";
export { CodeChunker } from "./core/chunker";
export { FileFilter } from "./core/file-filter";
export { SqliteStore, NativeBindingError } from "./core/sqlite-store";
export { classifyNativeBindingError, diagnosisOneLiner } from "./core/native-binding-error";
export type { NativeBindingDiagnosis, NativeBindingErrorKind } from "./core/native-binding-error";
export { HybridRetriever, reciprocalRankFusion } from "./core/retriever";
export { createReranker, VoyageReranker, CohereReranker, LocalReranker } from "./core/reranker";
export type { Reranker } from "./core/reranker";
export { createLogger, errText } from "./core/log";
export type { Logger, LogLevel, LogRecord } from "./core/log";
export { ContextAgent, defaultCodebaseTools, defaultAgentTools, FsEditApplier, editTools } from "./agent/agent";
export type { AgentConfig, AgentMessage, AgentRunOptions, LLMProvider, ToolCall, ToolDefinition, StreamEvent, EditProposal } from "./agent/types";
export type { EditApplier } from "./agent/edit-tools";
export { unifiedDiff } from "./core/diff";
export { createMCPServer, runMCPServer, startHttpServer } from "./mcp/server";
export type { RunMCPServerOptions, CreateMCPServerOptions, HttpTransportOptions } from "./mcp/server";
export type { File, Chunk, SearchResult, IndexingResult, OpenContextState, OpenContextConfig, EmbeddingConfig, SearchConfig, RerankerConfig, FreshnessReport, GitState, IndexMetadata } from "./core/types";
export { OpenAIEmbeddingProvider, VoyageEmbeddingProvider, OllamaEmbeddingProvider, LocalEmbeddingProvider, createEmbeddingProvider, isAuthError, localModelCacheDir } from "./core/embedder";
export type { EmbeddingProvider, EmbeddingInputType } from "./core/embedder";
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
export { ModelRouter, defaultRoutingConfig } from "./agent/model-router";
export type { DefaultRoutingOptions } from "./agent/model-router";
export type { ModelTier, RoutingConfig } from "./agent/model-router";
export { SessionMemory } from "./agent/session-memory";
export type { MemoryEntry, MemoryKind } from "./agent/session-memory";
export { AgentPlan, planTool } from "./agent/plan";
export type { PlanStep, PlanStepStatus } from "./agent/plan";
export { PermissionManager, describeToolCall } from "./agent/permissions";
export type { ApprovalMode, ApprovalDecision, ApprovalRequest, PermissionManagerOptions } from "./agent/permissions";
export { delegateTool } from "./agent/delegate";
export type { DelegateRunner, DelegateToolOptions } from "./agent/delegate";
export { collectEnvironment, renderEnvironment, environmentProvider } from "./agent/env";
export type { EnvironmentInfo } from "./agent/env";
export { SessionStore } from "./agent/session-store";
export type { SessionMeta, SavedSession } from "./agent/session-store";
export { splitForCompaction, renderTranscript, compactHistory, estimateTokens, totalTokens } from "./agent/utils";
export type { CompactionSplit, CompactionResult } from "./agent/utils";
export { OpenAICaller, AnthropicCaller, GoogleCaller, contextWindowFor } from "./agent/providers";
export type { LLMCaller, LLMResponse } from "./agent/providers";
export { resolveInside, isKeyishPath } from "./core/utils";
export { scrubbedEnv } from "./agent/extra-tools";
export {
  getLicense, verifyLicenseToken, isEntitled, requireFeature, loadEnterpriseEdition,
  saveLicenseToken, loadLicenseToken, clearLicense, licenseConfigPath, licenseConfigDir,
  serializeLicensePayload, DEFAULT_GRACE_DAYS, checkOrgDomainBinding,
} from "./core/license";
export type { Plan, Feature, LicensePayload, LicenseStatus, LicenseReason, VerifyOptions, OrgDomainCheck } from "./core/license";
export {
  loadPolicy, mergePolicies, emptyPolicy, verifySignedPolicy, describePolicy,
  policyAllowsEdits, policyAllowsShell, policyAllowsWebSearch, policyShellAllowlist,
  checkEmbeddingPolicy, policyRequiresAudit, LOCAL_EMBEDDING_PROVIDERS,
} from "./core/policy";
export type { PolicyRules, EffectivePolicy, SignedPolicyPayload, LoadPolicyOptions, VerifySignedPolicyOptions } from "./core/policy";
export { AuditLogger, readAuditEvents, verifyAuditChain, hashEvent, defaultAuditDir } from "./core/audit";
export type { AuditEvent, AuditLoggerOptions, ReadAuditOptions, AuditVerification } from "./core/audit";
export { ChunkWorkerPool, defaultPoolSize } from "./core/chunk-pool";
export type { ChunkedFile, ChunkPoolOptions } from "./core/chunk-pool";
export { readArtifactManifest, packArtifact, installArtifact, pushArtifact, pullArtifact, ARTIFACT_MANIFEST_KEY } from "./core/index-artifact";
export type { IndexArtifactManifest, TransportOptions } from "./core/index-artifact";
export { EmbedCache, defaultEmbedCachePath, contentHash } from "./core/embed-cache";
export type { EmbedCacheStats } from "./core/embed-cache";
export {
  verifyRevocationToken, loadCachedRevocations, saveRevocationToken, refreshRevocations, revocationCachePath,
} from "./core/license";
export type { RevocationList } from "./core/license";
