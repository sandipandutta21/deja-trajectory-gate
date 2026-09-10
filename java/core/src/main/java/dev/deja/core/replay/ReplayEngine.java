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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Resolves incoming JSON-RPC messages against a cassette: structural match first, semantic
 * fallback second. Transport-agnostic by design, so stdio replay and any server-style replay
 * built on top share exactly one implementation of "what does deja do with this request."
 * Mirrors the TypeScript implementation's {@code replayCore.ts}.
 */
public final class ReplayEngine {

    private final List<Interaction> interactions;
    private final int incompleteCount;
    private final boolean semanticEnabled;
    private final SemanticConfig semanticConfig;
    private final boolean consumeOnce;
    private final Set<Interaction> consumed = ConcurrentHashMap.newKeySet();

    public ReplayEngine(List<CassetteFrame> frames) {
        this(frames, false, null);
    }

    public ReplayEngine(List<CassetteFrame> frames, boolean semanticEnabled, SemanticConfig semanticConfig) {
        this(frames, semanticEnabled, semanticConfig, false);
    }

    /**
     * @param consumeOnce Default {@code false} (matching is stateless: a recorded interaction
     *                     can satisfy any number of matching requests, which is what lets
     *                     Trajectory Gate's own trajectory comparison be the thing that catches
     *                     an unexpected duplicate call). Set {@code true} for VCR-style one-shot
     *                     semantics instead: each recorded interaction is consumed by the first
     *                     request that matches it and is never offered to a later request.
     *                     Single-consumer semantics -- if multiple concurrent clients replay
     *                     against one engine instance with this on, they race for the same
     *                     interactions; every current call site constructs one engine per
     *                     session, so this isn't a supported multi-client scenario either way.
     */
    public ReplayEngine(List<CassetteFrame> frames, boolean semanticEnabled, SemanticConfig semanticConfig, boolean consumeOnce) {
        this.interactions = pairInteractions(frames);
        this.incompleteCount = findIncompleteRequests(frames).size();
        this.semanticEnabled = semanticEnabled;
        this.semanticConfig = semanticConfig != null ? semanticConfig : SemanticConfig.builder().build();
        this.consumeOnce = consumeOnce;
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

    /** Requests recorded in the cassette that never received a response -- these can never be
     *  matched during replay (there's nothing to serve), but are surfaced separately rather
     *  than silently discarded, so a caller can tell "this cassette is incomplete" from "this
     *  cassette just didn't record much." */
    public static List<CassetteFrame> findIncompleteRequests(List<CassetteFrame> frames) {
        Map<Object, CassetteFrame> pending = new LinkedHashMap<>();

        for (CassetteFrame frame : frames) {
            if (frame.dir() == Direction.C2S && frame.msg().id() != null) {
                pending.put(frame.msg().id(), frame);
            } else if (frame.dir() == Direction.S2C && frame.msg().id() != null) {
                pending.remove(frame.msg().id());
            }
        }

        return new ArrayList<>(pending.values());
    }

    /** Exported so a captured cassette can be scanned after the fact for replay-miss evidence
     *  (Trajectory Gate's divergence-frontier detection) without duplicating this literal. Kept
     *  for human-readable reports; detection itself keys off {@code NO_MATCH_ERROR_CODE}, not
     *  this string -- a message is not a stable internal API contract. */
    public static final String NO_MATCH_ERROR_MESSAGE = "Deja: No matching recorded request found in cassette";

    /** The JSON-RPC error code {@code buildNoMatchError} always uses -- exported so frontier
     *  detection can key off a stable numeric field instead of matching the message text. */
    public static final int NO_MATCH_ERROR_CODE = -32603;

    /** The canned response for a request the cassette has no recorded answer for. Uses
     *  -32603 (Internal error) rather than a JSON-RPC protocol-level code, since the *server*
     *  is fine -- it's deja's replay data that's incomplete. Returned per request, so one miss
     *  never poisons the rest of the session. */
    public static JsonRpcMessage buildNoMatchError(Object id) {
        return JsonRpcMessage.error(id, new JsonRpcError(NO_MATCH_ERROR_CODE, NO_MATCH_ERROR_MESSAGE));
    }

    public int recordedInteractionCount() {
        return interactions.size();
    }

    /** Requests recorded in the cassette that never received a response -- see
     *  {@link #findIncompleteRequests}. Diagnostic only: these were never matchable and
     *  matching behavior is unaffected either way. */
    public int incompleteInteractionCount() {
        return incompleteCount;
    }

    /** Notifications (no id) never produce a response, matched or not -- that's per JSON-RPC
     *  2.0. Every other message always resolves to a response: either the matched recording,
     *  or a synthesized no-match error. */
    public CompletableFuture<Optional<JsonRpcMessage>> resolve(JsonRpcMessage incoming) {
        if (incoming.isNotification()) {
            return CompletableFuture.completedFuture(Optional.empty());
        }

        List<Interaction> available = consumeOnce
                ? interactions.stream().filter(interaction -> !consumed.contains(interaction)).collect(Collectors.toList())
                : interactions;

        Optional<Interaction> structuralMatch = available.stream()
                .filter(interaction -> Match.matchStructural(incoming, interaction.request().msg()))
                .findFirst();

        if (structuralMatch.isPresent()) {
            if (consumeOnce) {
                consumed.add(structuralMatch.get());
            }
            return CompletableFuture.completedFuture(Optional.of(resolveResponse(structuralMatch.get(), incoming)));
        }

        if (!semanticEnabled) {
            return CompletableFuture.completedFuture(Optional.of(buildNoMatchError(incoming.id())));
        }

        SemanticMatchOptions<Interaction> options = SemanticMatchOptions.<Interaction>builder()
                .candidates(available)
                .messageExtractor(interaction -> interaction.request().msg())
                .threshold(semanticConfig.threshold())
                .judge(semanticConfig.judge())
                .build();

        return Match.findSemanticMatch(incoming, options)
                .thenApply(maybeMatch -> Optional.of(
                        maybeMatch.map(match -> {
                            if (consumeOnce) {
                                consumed.add(match);
                            }
                            return resolveResponse(match, incoming);
                        }).orElseGet(() -> buildNoMatchError(incoming.id()))));
    }

    private JsonRpcMessage resolveResponse(Interaction interaction, JsonRpcMessage incoming) {
        return interaction.response().msg().withId(incoming.id());
    }
}
