package dev.deja.core.trajectory;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.Direction;
import dev.deja.core.replay.ReplayEngine;
import lombok.experimental.UtilityClass;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** Mirrors the TypeScript implementation's {@code frontier.ts}. */
@UtilityClass
public class Frontier {

    /** @param firstMissFrameIndex the frame index of the request that went unserved -- not the
     *                             error response -- so the causing request itself (not just
     *                             what comes after it) is tagged post-divergence */
    public record TrajectorySession(int replayMisses, Integer firstMissFrameIndex) {
    }

    /**
     * Detects divergence-frontier evidence already sitting in a captured actual cassette: a
     * replay miss leaves {@code ReplayEngine.buildNoMatchError}'s sentinel error as the
     * recorded s2c response, so this recovers the frontier after the fact from the wire
     * transcript alone -- no live gate session or capture-tee metadata needed.
     */
    public Optional<TrajectorySession> detectReplaySession(List<CassetteFrame> frames) {
        int replayMisses = 0;
        Integer firstMissFrameIndex = null;

        for (int frameIndex = 0; frameIndex < frames.size(); frameIndex++) {
            CassetteFrame frame = frames.get(frameIndex);
            if (frame.dir() != Direction.S2C) {
                continue;
            }
            if (frame.msg().error() == null || !ReplayEngine.NO_MATCH_ERROR_MESSAGE.equals(frame.msg().error().message())) {
                continue;
            }

            replayMisses++;
            if (firstMissFrameIndex != null) {
                continue;
            }

            Object missId = frame.msg().id();
            int requestFrameIndex = -1;
            for (int i = 0; i < frameIndex; i++) {
                CassetteFrame candidate = frames.get(i);
                if (candidate.dir() == Direction.C2S && Objects.equals(candidate.msg().id(), missId)) {
                    requestFrameIndex = i;
                    break;
                }
            }
            firstMissFrameIndex = requestFrameIndex >= 0 ? requestFrameIndex : frameIndex;
        }

        if (replayMisses == 0) {
            return Optional.empty();
        }
        return Optional.of(new TrajectorySession(replayMisses, firstMissFrameIndex));
    }
}
