export type TransportType = "stdio" | "http";
export type Direction = "c2s" | "s2c";

export interface CassetteHeader {
    type: "header";
    version: 1;
    recorded_at: string;
    transport: TransportType;
    server_command?: string[];
    target?: string;
}

export interface JsonRpcMessage {
    jsonrpc: "2.0";
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export interface CassetteFrame {
    type: "frame";
    dir: Direction;
    t_ms: number;
    msg: JsonRpcMessage;
}

export type CassetteLine = CassetteHeader | CassetteFrame;

export type MatchingTier = "exact" | "structural" | "semantic";

export interface SemanticConfig {
    /**
     * Minimum deterministic similarity score to accept a match.
     * Default: 0.75
     */
    threshold?: number;
    /**
     * Optional LLM fallback, consulted only for the "uncertain band" just
     * under the threshold -- a tiebreaker, never the primary matcher.
     */
    judge?: (incoming: JsonRpcMessage, recorded: JsonRpcMessage) => Promise<{ equivalent: boolean }>;
}

export interface ReplayOptions {
    semantic?: boolean | SemanticConfig;
    port?: number;
    stdio?: boolean;
    /** When set, every inbound/outbound wire frame is tee'd (redacted, with fresh capture-local
     *  timestamps) into a cassette at this path. The golden itself is never mutated. */
    capture?: string;
}

export interface RecordOptions {
    noRedact?: boolean;
    port?: number;
    target?: string;
}

/** A recorded request paired with the response the cassette will replay for it. */
export interface Interaction {
    request: CassetteFrame;
    response: CassetteFrame;
}

export interface SemanticMatchOptions<T> {
    candidates: T[];
    getMessage: (candidate: T) => JsonRpcMessage;
    threshold?: number;
    judge?: SemanticConfig["judge"];
}

export interface VerifyOptions {
    ignoreFields?: string[];
    ignorePaths?: string[];
    update?: boolean;
}

export interface VerifyDifference {
    requestId: string | number | undefined;
    method?: string;
    expected: unknown;
    received: unknown;
}

export interface VerifyReport {
    totalRequests: number;
    checked: number;
    differences: VerifyDifference[];
}

export type ChangeSeverity = "breaking" | "minor";

export type DiffCategory =
    | "tool-removed"
    | "tool-added"
    | "param-now-required"
    | "result-error-flip"
    | "field-removed";

export interface DiffChange {
    severity: ChangeSeverity;
    category: DiffCategory;
    message: string;
    tool?: string;
    field?: string;
}

export interface DiffReport {
    changes: DiffChange[];
    breakingCount: number;
    minorCount: number;
}

export interface RedactScanHit {
    frameIndex: number;
    rule: string;
}

export interface RedactScanReport {
    file: string;
    hits: RedactScanHit[];
}
