import { normalizeMessage } from "../core/match.js";
import { CassetteFrame, JsonRpcMessage } from "../core/types.js";
import { TrajectoryExtractionOptions, TrajectoryStep } from "./types.js";

/** Excluded by default; a name passed via `options.include` overrides this. */
const DEFAULT_EXCLUDED_METHODS = new Set(["initialize"]);

function isClientRequest(msg: JsonRpcMessage): boolean {
    // A notification (no `id`) never produces a response and asserts no expectation of one --
    // it is not client *action* evidence the way a request awaiting a reply is.
    return typeof msg.method === "string" && msg.id !== undefined;
}

/**
 * Extracts the deterministic, ordered sequence of asserted client actions from a cassette's
 * wire frames. Operates directly on frames rather than `pairInteractions`'s
 * request/response pairs: a request that never got a recorded response -- e.g. the one request
 * a replay session couldn't serve -- is still meaningful trajectory evidence and must not be
 * silently dropped the way an unpaired request is for replay purposes.
 */
export function extractTrajectory(
    frames: CassetteFrame[],
    options: TrajectoryExtractionOptions = {}
): TrajectoryStep[] {
    const included = new Set(options.include ?? []);
    const steps: TrajectoryStep[] = [];

    frames.forEach((frame, frameIndex) => {
        if (frame.dir !== "c2s") return; // server-initiated traffic is never an asserted step
        if (!isClientRequest(frame.msg)) return;

        const method = frame.msg.method as string;
        if (DEFAULT_EXCLUDED_METHODS.has(method) && !included.has(method)) return;

        const normalized = normalizeMessage(frame.msg);
        const params = normalized.params ?? {};
        const toolName =
            method === "tools/call" ? (params as { name?: unknown }).name : undefined;

        steps.push({
            index: steps.length,
            method,
            toolName: typeof toolName === "string" ? toolName : undefined,
            params,
            frameIndex,
            tMs: frame.t_ms,
        });
    });

    return steps;
}
