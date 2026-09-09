import { findSemanticMatch, matchStructural } from "./match.js";
import { CassetteFrame, Interaction, JsonRpcMessage, SemanticConfig } from "./types.js";

/**
 * Pairs recorded client requests with their recorded responses by JSON-RPC id. A request that
 * never got a recorded response (e.g. the recording process was killed mid-flight) is dropped
 * silently -- it simply can never be matched during replay.
 */
export function pairInteractions(frames: CassetteFrame[]): Interaction[] {
    const pairs: Interaction[] = [];
    const pending = new Map<string | number, CassetteFrame>();

    for (const frame of frames) {
        if (frame.dir === "c2s" && frame.msg.id !== undefined) {
            pending.set(frame.msg.id, frame);
        } else if (frame.dir === "s2c" && frame.msg.id !== undefined) {
            const request = pending.get(frame.msg.id);
            if (request) {
                pairs.push({ request, response: frame });
                pending.delete(frame.msg.id);
            }
        }
    }

    return pairs;
}

/** Exported so a captured cassette can be scanned after the fact for replay-miss evidence
 *  (e.g. trajectory's divergence-frontier detection) without duplicating this literal. Kept
 *  around for human-readable reports; detection itself keys off `NO_MATCH_ERROR_CODE`, not
 *  this string -- a message is not a stable internal API contract. */
export const NO_MATCH_ERROR_MESSAGE = "Deja: No matching recorded request found in cassette";

/** The JSON-RPC error code `buildNoMatchError` always uses -- exported so frontier detection
 *  can key off a stable numeric field instead of matching `NO_MATCH_ERROR_MESSAGE`'s text. */
export const NO_MATCH_ERROR_CODE = -32603;

/**
 * The canned response for a request the cassette has no recorded answer for. This uses
 * -32603 (Internal error) rather than -32601 (Method not found): the *method* the client
 * asked for is perfectly valid, it's deja's replay data that's incomplete. Returned per
 * request, so one miss never poisons the rest of the session.
 */
export function buildNoMatchError(id: string | number | undefined): JsonRpcMessage {
    return {
        jsonrpc: "2.0",
        id,
        error: {
            code: NO_MATCH_ERROR_CODE,
            message: NO_MATCH_ERROR_MESSAGE,
        },
    };
}

export interface ReplayEngineOptions {
    frames: CassetteFrame[];
    semantic?: boolean | SemanticConfig;
    /** Default `false` (matching is stateless: a recorded interaction can satisfy any number
     *  of matching requests, which is what lets Trajectory Gate's own trajectory comparison be
     *  the thing that catches an unexpected duplicate call -- see `gate/`). Set `true` for
     *  VCR-style one-shot semantics instead: each recorded interaction is consumed by the first
     *  request that matches it and is never offered to a later request, so a genuine duplicate
     *  call misses on its second occurrence. Single-consumer semantics -- if multiple concurrent
     *  clients replay against one engine instance with this on, they race for the same
     *  interactions; every current call site constructs one engine per session, so this isn't a
     *  supported multi-client scenario either way. */
    consumeOnce?: boolean;
}

/**
 * Resolves incoming JSON-RPC messages against a cassette: structural match first, semantic
 * fallback second. Shared verbatim by stdio replay and the HTTP replay server, so "what does
 * deja do with this request" has exactly one implementation and one test suite.
 */
export class ReplayEngine {
    private readonly interactions: Interaction[];
    private readonly semanticEnabled: boolean;
    private readonly semanticConfig: SemanticConfig;
    private readonly consumeOnce: boolean;
    private readonly consumed = new Set<Interaction>();

    constructor(options: ReplayEngineOptions) {
        this.interactions = pairInteractions(options.frames);
        this.semanticEnabled = !!options.semantic;
        this.semanticConfig = typeof options.semantic === "object" ? options.semantic : {};
        this.consumeOnce = !!options.consumeOnce;
    }

    get recordedInteractionCount(): number {
        return this.interactions.length;
    }

    /** Notifications (no `id`) never produce a response, matched or not -- that's per JSON-RPC 2.0. */
    async resolve(incoming: JsonRpcMessage): Promise<JsonRpcMessage | null> {
        if (incoming.id === undefined) return null;

        const available = this.consumeOnce
            ? this.interactions.filter((interaction) => !this.consumed.has(interaction))
            : this.interactions;

        const structuralMatch = available.find((interaction) => matchStructural(incoming, interaction.request.msg));
        let match = structuralMatch ?? null;

        if (!match && this.semanticEnabled) {
            match = await findSemanticMatch(incoming, {
                candidates: available,
                getMessage: (interaction) => interaction.request.msg,
                threshold: this.semanticConfig.threshold,
                judge: this.semanticConfig.judge,
            });
        }

        if (!match) return buildNoMatchError(incoming.id);
        if (this.consumeOnce) this.consumed.add(match);
        return { ...match.response.msg, id: incoming.id };
    }
}

/** A plain object becomes a single-element array, so a lone message and a JSON-RPC batch
 *  array share one code path everywhere downstream. */
export function normalizeIncoming(raw: unknown): JsonRpcMessage[] {
    return Array.isArray(raw) ? (raw as JsonRpcMessage[]) : [raw as JsonRpcMessage];
}

/** Resolves every message in a batch, dropping the `null`s notifications produce -- callers
 *  only see responses that actually need sending back. */
export async function resolveBatch(engine: ReplayEngine, messages: JsonRpcMessage[]): Promise<JsonRpcMessage[]> {
    const responses: JsonRpcMessage[] = [];
    for (const message of messages) {
        const response = await engine.resolve(message);
        if (response) responses.push(response);
    }
    return responses;
}