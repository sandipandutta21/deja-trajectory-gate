package dev.deja.core.replay;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.Interaction;
import dev.deja.core.cassette.JsonRpcError;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.match.Match;
import dev.deja.core.match.SemanticConfig;
import dev.deja.core.match.SemanticMatchOptions;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Resolves incoming JSON-RPC messages against a cassette: structural match first, semantic
 * fallback second. Transport-agnostic by design, so stdio replay and any server-style replay
 * built on top share exactly one implementation of "what does deja do with this request."
 * Mirrors the TypeScript implementation's {@code replayCore.ts}.
 */
public final class ReplayEngine {

    private final List<Interaction> interactions;
    private final boolean semanticEnabled;
    private final SemanticConfig semanticConfig;

    public ReplayEngine(List<CassetteFrame> frames) {
        this(frames, false, null);
    }

    public ReplayEngine(List<CassetteFrame> frames, boolean semanticEnabled, SemanticConfig semanticConfig) {
        this.interactions = pairInteractions(frames);
        this.semanticEnabled = semanticEnabled;
        this.semanticConfig = semanticConfig != null ? semanticConfig : SemanticConfig.builder().build();
    }

    /** Pairs recorded client requests with their recorded responses by JSON-RPC id. A request
     *  that never received a recorded response (e.g. the recording was killed mid-flight) is
     *  dropped silently -- it simply can never be matched during replay. */
    public static List<Interaction> pairInteractions(List<CassetteFrame> frames) {
        List<Interaction> pairs = new ArrayList<>();
        Map<Object, CassetteFrame> pending = new HashMap<>();

        for (CassetteFrame frame : frames) {
            if (frame.dir() == Direction.C2S && frame.msg().id() != null) {
                pending.put(frame.msg().id(), frame);
            } else if (frame.dir() == Direction.S2C && frame.msg().id() != null) {
                CassetteFrame request = pending.remove(frame.msg().id());
                if (request != null) {
                    pairs.add(new Interaction(request, frame));
                }
            }
        }

        return pairs;
    }

    /** Exported so a captured cassette can be scanned after the fact for replay-miss evidence
     *  (Trajectory Gate's divergence-frontier detection) without duplicating this literal. */
    public static final String NO_MATCH_ERROR_MESSAGE = "Deja: No matching recorded request found in cassette";

    /** The canned response for a request the cassette has no recorded answer for. Uses
     *  -32603 (Internal error) rather than a JSON-RPC protocol-level code, since the *server*
     *  is fine -- it's deja's replay data that's incomplete. Returned per request, so one miss
     *  never poisons the rest of the session. */
    public static JsonRpcMessage buildNoMatchError(Object id) {
        return JsonRpcMessage.error(id, new JsonRpcError(-32603, NO_MATCH_ERROR_MESSAGE));
    }

    public int recordedInteractionCount() {
        return interactions.size();
    }

    /** Notifications (no id) never produce a response, matched or not -- that's per JSON-RPC
     *  2.0. Every other message always resolves to a response: either the matched recording,
     *  or a synthesized no-match error. */
    public CompletableFuture<Optional<JsonRpcMessage>> resolve(JsonRpcMessage incoming) {
        if (incoming.isNotification()) {
            return CompletableFuture.completedFuture(Optional.empty());
        }

        Optional<Interaction> structuralMatch = interactions.stream()
                .filter(interaction -> Match.matchStructural(incoming, interaction.request().msg()))
                .findFirst();

        if (structuralMatch.isPresent()) {
            return CompletableFuture.completedFuture(Optional.of(resolveResponse(structuralMatch.get(), incoming)));
        }

        if (!semanticEnabled) {
            return CompletableFuture.completedFuture(Optional.of(buildNoMatchError(incoming.id())));
        }

        SemanticMatchOptions<Interaction> options = SemanticMatchOptions.<Interaction>builder()
                .candidates(interactions)
                .messageExtractor(interaction -> interaction.request().msg())
                .threshold(semanticConfig.threshold())
                .judge(semanticConfig.judge())
                .build();

        return Match.findSemanticMatch(incoming, options)
                .thenApply(maybeMatch -> Optional.of(
                        maybeMatch.map(match -> resolveResponse(match, incoming))
                                .orElseGet(() -> buildNoMatchError(incoming.id()))));
    }

    private JsonRpcMessage resolveResponse(Interaction interaction, JsonRpcMessage incoming) {
        return interaction.response().msg().withId(incoming.id());
    }
}
