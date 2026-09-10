import { stableStringify } from "./canon.js";
import { JsonRpcMessage, SemanticConfig, SemanticMatchOptions } from "./types.js";

/** Composite weights for the semantic tier. Structural shape carries the most signal;
 *  token overlap and character-level similarity are corroborating evidence. */
const WEIGHT_STRUCTURAL = 0.45;
const WEIGHT_TOKEN_JACCARD = 0.35;
const WEIGHT_TRIGRAM_DICE = 0.2;

/** Width of the "uncertain band" just below `threshold` that gets escalated to an LLM judge
 *  instead of being rejected outright. Keeps the judge a tiebreaker, not a primary matcher. */
const JUDGE_BAND_WIDTH = 0.15;

const MAX_RECURSION_DEPTH = 50;

/** A numeric leaf pair is a hard mismatch -- forced REJECT ahead of the fuzzy scoring below,
 *  regardless of how similar the rest of the payload is -- when the two values differ by more
 *  than half of their magnitude (`numericCloseness` below this). A 10x change in a transfer
 *  amount or a 100x change in an order quantity must never be blended away by an otherwise
 *  identical payload; a paging `limit` off by one, or a retry count nudged up slightly, stays
 *  in the fuzzy-scored band, since a generic structural matcher has no field-level semantics
 *  to tell "amount" from "limit" -- only how far apart two numbers are. Found via benchmarking
 *  (see ../../benchmarks): the original implementation blended a numeric leaf's low
 *  numericCloseness in with token/trigram similarity computed over the *whole* stringified
 *  params object, so an unrelated field matching exactly (the tool name, a shared key, an
 *  unrelated argument) could "buy back" enough score to still clear the match threshold. */
const NUMERIC_HARD_GATE_MIN_CLOSENESS = 0.5;

/**
 * Fast-fails structural-tier matching across different tools: a recorded `fetch` call must
 * never satisfy an incoming `write_file` call just because both are `tools/call` envelopes.
 */
function toolNamesCompatible(incoming: JsonRpcMessage, recorded: JsonRpcMessage): boolean {
    if (incoming.method !== "tools/call") return true;
    const incomingName = (incoming.params as { name?: unknown } | undefined)?.name;
    const recordedName = (recorded.params as { name?: unknown } | undefined)?.name;
    return incomingName === recordedName;
}

/** Strips fields that legitimately vary run-to-run without changing request identity. */
export function normalizeMessage(msg: JsonRpcMessage): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(msg)) as Record<string, any>;

    if (clone.params) {
        if (clone.params._meta) {
            delete clone.params._meta;
        }
        if (Object.keys(clone.params).length === 0) {
            delete clone.params;
        }
    }

    delete clone.id;

    return clone;
}

/** Tier 1/2: exact structural equality, independent of key order. */
export function matchStructural(incoming: JsonRpcMessage, recorded: JsonRpcMessage): boolean {
    if (incoming.method !== recorded.method) return false;
    if (!toolNamesCompatible(incoming, recorded)) return false;

    const cleanIncoming = normalizeMessage(incoming);
    const cleanRecorded = normalizeMessage(recorded);

    return stableStringify(cleanIncoming) === stableStringify(cleanRecorded);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Character-trigram set for Dice comparison; short strings fall back to whole-string identity. */
function trigrams(value: string): Set<string> {
    const normalized = value.toLowerCase();
    if (normalized.length < 3) return new Set([normalized]);

    const grams = new Set<string>();
    for (let i = 0; i <= normalized.length - 3; i++) {
        grams.add(normalized.slice(i, i + 3));
    }
    return grams;
}

/** Dice coefficient over character trigrams -- tolerant of typos, param reordering, minor phrasing drift. */
export function trigramDice(a: string, b: string): number {
    if (a === b) return 1;

    const gramsA = trigrams(a);
    const gramsB = trigrams(b);
    if (gramsA.size === 0 || gramsB.size === 0) return 0;

    let intersection = 0;
    for (const gram of gramsA) {
        if (gramsB.has(gram)) intersection++;
    }

    return (2 * intersection) / (gramsA.size + gramsB.size);
}

/** Splits a value into a lowercase word-token bag for order-agnostic overlap comparison. */
function tokenize(value: unknown): Set<string> {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    return new Set(tokens);
}

/** Jaccard similarity: |intersection| / |union|, over token sets. */
export function tokenJaccard(a: unknown, b: unknown): number {
    const setA = tokenize(a);
    const setB = tokenize(b);
    if (setA.size === 0 && setB.size === 0) return 1;

    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 1 : intersection / union;
}

/** Relative numeric closeness, scaled so magnitude doesn't dominate (e.g. 1 vs 2 and 1001 vs 1002 differ). */
export function numericCloseness(a: number, b: number): number {
    if (a === b) return 1;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.max(0, 1 - Math.abs(a - b) / scale);
}

function arraySimilarity(a: unknown[], b: unknown[], depth: number): number {
    if (a.length === 0 && b.length === 0) return 1;
    const maxLength = Math.max(a.length, b.length);

    let total = 0;
    for (let i = 0; i < maxLength; i++) {
        total += structuralSimilarity(a[i], b[i], depth + 1);
    }
    return total / maxLength;
}

function objectSimilarity(a: Record<string, unknown>, b: Record<string, unknown>, depth: number): number {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return 1;

    let total = 0;
    for (const key of keys) {
        total += structuralSimilarity(a[key], b[key], depth + 1);
    }
    return total / keys.size;
}

/**
 * Recursively compares two values shape-by-shape, weighting each leaf by type-appropriate
 * closeness (numeric distance, trigram Dice for strings, exact for booleans) and each
 * container by the fraction of its keys/indices that resolved well on the other side.
 * Missing keys and type mismatches are penalized, not ignored, so a recorded request with
 * extra required fields won't falsely satisfy a leaner incoming one.
 */
function structuralSimilarity(a: unknown, b: unknown, depth = 0): number {
    if (depth > MAX_RECURSION_DEPTH) return a === b ? 1 : 0;
    if (a === b) return 1;
    if (a === null || b === null || a === undefined || b === undefined) return 0;

    if (typeof a === "number" && typeof b === "number") return numericCloseness(a, b);
    if (typeof a === "string" && typeof b === "string") return trigramDice(a, b);
    if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 1 : 0;

    if (Array.isArray(a) && Array.isArray(b)) return arraySimilarity(a, b, depth);
    if (isPlainObject(a) && isPlainObject(b)) return objectSimilarity(a, b, depth);

    return 0; // type mismatch (e.g. string vs. array) never contributes similarity
}

/** A string that looks like a path or URI (contains a separator) is an opaque identifier,
 *  not prose: two different paths are never "close enough" no matter how much of the string
 *  they share -- e.g. "/data/secrets.txt" and "/data/readme.txt" share a long literal prefix
 *  and would otherwise score deceptively high on generic character/word similarity. */
function looksLikePathOrUri(value: string): boolean {
    return value.includes("/") || value.includes("\\");
}

/**
 * Recursively walks two values in parallel looking for a leaf pair that must force a hard
 * REJECT ahead of the fuzzy scoring below, however high its overall similarity would
 * otherwise land: two unequal path/URI-shaped strings (fuzzy-matching an identifier would
 * risk confidently returning one resource's content, or performing one resource's mutation,
 * for a request naming a different one), or two numbers far enough apart to be a different
 * real-world quantity (see {@link NUMERIC_HARD_GATE_MIN_CLOSENESS}).
 */
function hasHardMismatch(a: unknown, b: unknown, depth = 0): boolean {
    if (depth > MAX_RECURSION_DEPTH) return false;

    if (typeof a === "string" && typeof b === "string") {
        return a !== b && (looksLikePathOrUri(a) || looksLikePathOrUri(b));
    }

    if (typeof a === "number" && typeof b === "number") {
        return numericCloseness(a, b) < NUMERIC_HARD_GATE_MIN_CLOSENESS;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        const maxLength = Math.max(a.length, b.length);
        for (let i = 0; i < maxLength; i++) {
            if (hasHardMismatch(a[i], b[i], depth + 1)) return true;
        }
        return false;
    }

    if (isPlainObject(a) && isPlainObject(b)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (hasHardMismatch(a[key], b[key], depth + 1)) return true;
        }
        return false;
    }

    return false;
}

/** Collects every pair of corresponding leaf strings from two parallel-shaped values --
 *  positionally, by the same array index or object key -- e.g. every prose/free-text argument
 *  in a request's params. Numbers, booleans, and overall shape are already scored by
 *  {@link structuralSimilarity}; folding them into a whole-object JSON.stringify for the
 *  token/trigram channel too (the original implementation) let an exactly-matching sibling
 *  field (a shared key name, the tool name itself) "buy back" enough score to paper over a
 *  sibling argument that actually changed. Restricting that channel to just the string leaves
 *  closes that gap without touching structuralSimilarity's own (already correct) per-leaf
 *  handling of every other type. */
function collectStringLeafPairs(a: unknown, b: unknown, depth: number, out: Array<[string, string]>): void {
    if (depth > MAX_RECURSION_DEPTH) return;

    if (typeof a === "string" && typeof b === "string") {
        out.push([a, b]);
        return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        const maxLength = Math.max(a.length, b.length);
        for (let i = 0; i < maxLength; i++) {
            collectStringLeafPairs(a[i], b[i], depth + 1, out);
        }
        return;
    }

    if (isPlainObject(a) && isPlainObject(b)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            collectStringLeafPairs(a[key], b[key], depth + 1, out);
        }
    }
}

/** Joins collected leaf strings with a control character essentially never present in real
 *  prose, so token/trigram comparison can't accidentally merge the tail of one leaf with the
 *  head of the next into a token that never existed in either original value. */
const LEAF_JOIN_SEPARATOR = "␟";

/**
 * Tier 3: deterministic semantic similarity in [0, 1]. Combines structural shape, token
 * overlap, and character-level similarity of the request params. Requires zero network
 * access or model calls -- fully reproducible in CI.
 */
export function calculateSimilarity(incoming: JsonRpcMessage, recorded: JsonRpcMessage): number {
    if (incoming.method !== recorded.method) return 0;
    if (!toolNamesCompatible(incoming, recorded)) return 0;
    if (matchStructural(incoming, recorded)) return 1;

    const incomingParams = normalizeMessage(incoming).params ?? {};
    const recordedParams = normalizeMessage(recorded).params ?? {};

    if (hasHardMismatch(incomingParams, recordedParams)) return 0;

    const structural = structuralSimilarity(incomingParams, recordedParams);

    const leafPairs: Array<[string, string]> = [];
    collectStringLeafPairs(incomingParams, recordedParams, 0, leafPairs);
    // No string leaves at all (e.g. every argument is numeric) -- neutral, not penalizing:
    // there's no prose signal to contradict what structuralSimilarity already scored.
    const joinedIncoming = leafPairs.map(([a]) => a).join(LEAF_JOIN_SEPARATOR);
    const joinedRecorded = leafPairs.map(([, b]) => b).join(LEAF_JOIN_SEPARATOR);
    const tokens = leafPairs.length === 0 ? 1 : tokenJaccard(joinedIncoming, joinedRecorded);
    const trigram = leafPairs.length === 0 ? 1 : trigramDice(joinedIncoming, joinedRecorded);

    const score = WEIGHT_STRUCTURAL * structural + WEIGHT_TOKEN_JACCARD * tokens + WEIGHT_TRIGRAM_DICE * trigram;
    return Math.max(0, Math.min(1, score));
}

/**
 * Generic best-match search shared by stdio replay, HTTP replay, and the vitest fixture:
 * ranks candidates by `calculateSimilarity`, accepts the top scorer at or above `threshold`,
 * and -- only when a `judge` is configured and no candidate clears the threshold -- escalates
 * the highest-scoring candidates within `JUDGE_BAND_WIDTH` below it for an LLM tiebreak.
 */
export async function findSemanticMatch<T>(
    incoming: JsonRpcMessage,
    options: SemanticMatchOptions<T>
): Promise<T | null> {
    const threshold = options.threshold ?? 0.75;

    let best: T | null = null;
    let bestScore = 0;
    // True when a *different* candidate ties the current best score -- picking either would be
    // arbitrary, so this fails closed (treated as no match) rather than silently keeping
    // whichever was scanned first.
    let ambiguous = false;
    const uncertain: Array<{ candidate: T; score: number }> = [];

    for (const candidate of options.candidates) {
        const score = calculateSimilarity(incoming, options.getMessage(candidate));

        if (score >= threshold) {
            if (best === null || score > bestScore) {
                bestScore = score;
                best = candidate;
                ambiguous = false;
            } else if (score === bestScore) {
                ambiguous = true;
            }
        } else if (options.judge && score >= threshold - JUDGE_BAND_WIDTH) {
            uncertain.push({ candidate, score });
        }
    }

    if (best) return ambiguous ? null : best;
    if (!options.judge || uncertain.length === 0) return null;

    uncertain.sort((a, b) => b.score - a.score);
    for (const { candidate } of uncertain) {
        const verdict = await options.judge(incoming, options.getMessage(candidate));
        if (verdict.equivalent) return candidate;
    }

    return null;
}

export type { SemanticConfig };