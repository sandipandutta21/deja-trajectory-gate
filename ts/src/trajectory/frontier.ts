import { NO_MATCH_ERROR_CODE } from "../core/replayEngine.js";
import { CassetteFrame } from "../core/types.js";
import { TrajectorySession } from "./types.js";

/**
 * Detects divergence-frontier evidence already sitting in a captured actual cassette: a replay
 * miss leaves `buildNoMatchError`'s sentinel error as the recorded s2c response, so this recovers
 * the frontier after the fact from the wire transcript alone -- no live gate session or
 * capture-tee metadata needed.
 */
export function detectReplaySession(frames: CassetteFrame[]): TrajectorySession | undefined {
    let replayMisses = 0;
    let firstMissFrameIndex: number | undefined;

    frames.forEach((frame, frameIndex) => {
        if (frame.dir !== "s2c") return;
        if (frame.msg.error?.code !== NO_MATCH_ERROR_CODE) return;

        replayMisses++;
        if (firstMissFrameIndex !== undefined) return;

        // The frontier is the *request* that went unserved, not the error response -- so the
        // causing request itself (not just what comes after it) is tagged post-divergence.
        const requestFrameIndex = frames.findIndex(
            (candidate, i) => i < frameIndex && candidate.dir === "c2s" && candidate.msg.id === frame.msg.id
        );
        firstMissFrameIndex = requestFrameIndex >= 0 ? requestFrameIndex : frameIndex;
    });

    if (replayMisses === 0) return undefined;
    return { replayMisses, firstMissFrameIndex };
}
