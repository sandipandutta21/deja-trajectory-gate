export * from "./core/types.js";

export { CassetteReader, CassetteWriter } from "./core/cassette.js";
export { sortKeysDeep, stableStringify } from "./core/canon.js";

export {
    calculateSimilarity,
    findSemanticMatch,
    matchStructural,
    normalizeMessage,
    numericCloseness,
    tokenJaccard,
    trigramDice,
} from "./core/match.js";

export {
    containsSecret,
    createPlaceholder,
    redactCommand,
    redactObject,
    redactString,
    scanForSecrets,
    toOriginOnly,
} from "./core/redact.js";

export { IGNORED_SENTINEL, maskPath } from "./core/jsonpath.js";

export { buildNoMatchError, normalizeIncoming, pairInteractions, ReplayEngine, resolveBatch } from "./core/replayEngine.js";
export type { ReplayEngineOptions } from "./core/replayEngine.js";

export { extractJsonRpcFromSse, formatSseEvent, SseParser } from "./transport/http/sse.js";
export type { SseEvent } from "./transport/http/sse.js";

export { recordHttp, recordStdio } from "./command/record.js";
export type { RecordHttpOptions } from "./command/record.js";

export { replayHttp, replayStdio } from "./command/replay.js";

export { startHttpRecordProxy } from "./transport/http/proxy.js";
export type { HttpProxyHandle } from "./transport/http/proxy.js";

export { startHttpReplayServer } from "./transport/http/server.js";
export type { HttpReplayHandle } from "./transport/http/server.js";

export { cleanCassette, runClean, runScan, scanCassette } from "./command/redact.js";

export { diffCassettes } from "./command/diff.js";
export { verifyCassette } from "./command/verify.js";

export { compareTrajectoryCassettes, deriveTrajectoryPolicy, readTrajectoryPolicy } from "./command/trajectory.js";
export { parseDurationMs, runGate } from "./command/gate.js";
export type { RunGateOptions, RunGateResult } from "./command/gate.js";
export type { GateExitCode } from "./gate/run.js";
export { openCapture } from "./gate/capture.js";
export type { ReplayCapture } from "./gate/capture.js";
export { runAgent } from "./gate/lifecycle.js";
export type { AgentRun, AgentRunResult } from "./gate/lifecycle.js";

export * from "./trajectory/types.js";
export { extractTrajectory } from "./trajectory/extract.js";
export { alignStrict, alignUnordered } from "./trajectory/alignment.js";
export type { AlignedPair } from "./trajectory/alignment.js";
export { compareCassetteFrames, compareTrajectories } from "./trajectory/compare.js";
export type { CompareCassetteFramesOptions } from "./trajectory/compare.js";
export { derivePolicy, findAllPolicyMatches, findPolicyMatch, isCoveredByAnyMatcher } from "./trajectory/policy.js";
export { detectReplaySession } from "./trajectory/frontier.js";
export { renderHumanReport, toCanonicalJson, toCanonicalReport } from "./trajectory/report.js";

