package dev.deja.core.trajectory;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import lombok.experimental.UtilityClass;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Mirrors the TypeScript implementation's {@code extract.ts}. */
@UtilityClass
public class Extract {

    /** Excluded by default; a name passed via {@code include} overrides this. */
    private final Set<String> DEFAULT_EXCLUDED_METHODS = Set.of("initialize");

    /** Strips fields that legitimately vary run-to-run without changing request identity --
     *  the same normalization {@link dev.deja.core.match.Match} applies, duplicated here since
     *  that method is private to the match package. */
    private Map<String, Object> normalizedParams(JsonRpcMessage msg) {
        Map<String, Object> params = msg.params();
        if (params == null) {
            return null;
        }
        Map<String, Object> mutable = new LinkedHashMap<>(params);
        mutable.remove("_meta");
        return mutable.isEmpty() ? null : mutable;
    }

    public List<TrajectoryStep> extractTrajectory(List<CassetteFrame> frames) {
        return extractTrajectory(frames, Set.of());
    }

    /**
     * Extracts the deterministic, ordered sequence of asserted client actions from a cassette's
     * wire frames. Operates directly on frames rather than {@code
     * ReplayEngine.pairInteractions}'s request/response pairs: a request that never got a
     * recorded response -- e.g. the one request a replay session couldn't serve -- is still
     * meaningful trajectory evidence and must not be silently dropped the way an unpaired
     * request is for replay purposes.
     */
    public List<TrajectoryStep> extractTrajectory(List<CassetteFrame> frames, Set<String> include) {
        List<TrajectoryStep> steps = new ArrayList<>();

        for (int frameIndex = 0; frameIndex < frames.size(); frameIndex++) {
            CassetteFrame frame = frames.get(frameIndex);
            if (frame.dir() != Direction.C2S) {
                continue; // server-initiated traffic is never an asserted step
            }

            JsonRpcMessage msg = frame.msg();
            if (msg.method() == null || msg.isNotification()) {
                continue;
            }

            String method = msg.method();
            if (DEFAULT_EXCLUDED_METHODS.contains(method) && !include.contains(method)) {
                continue;
            }

            Map<String, Object> params = normalizedParams(msg);
            String toolName = null;
            if ("tools/call".equals(method) && params != null && params.get("name") instanceof String name) {
                toolName = name;
            }

            steps.add(new TrajectoryStep(steps.size(), method, toolName, params, frameIndex, frame.tMs()));
        }

        return steps;
    }
}
