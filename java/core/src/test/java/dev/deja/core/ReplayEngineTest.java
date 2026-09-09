package dev.deja.core;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.Interaction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.replay.ReplayEngine;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

import static org.assertj.core.api.Assertions.assertThat;

class ReplayEngineTest {

    private CassetteFrame frame(Direction dir, JsonRpcMessage msg) {
        return CassetteFrame.of(dir, 0, msg);
    }

    private <T> T await(CompletableFuture<T> future) {
        try {
            return future.get();
        } catch (InterruptedException | ExecutionException e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void pairsACassetteRequestWithItsMatchingResponseById() {
        List<CassetteFrame> frames = List.of(
                frame(Direction.C2S, JsonRpcMessage.request(1, "tools/list", null)),
                frame(Direction.S2C, JsonRpcMessage.result(1, Map.of("tools", List.of()))));

        List<Interaction> pairs = ReplayEngine.pairInteractions(frames);
        assertThat(pairs).hasSize(1);
        assertThat(pairs.get(0).request().msg().method()).isEqualTo("tools/list");
    }

    @Test
    void dropsRequestsThatNeverReceivedARecordedResponse() {
        List<CassetteFrame> frames = List.of(frame(Direction.C2S, JsonRpcMessage.request(1, "tools/list", null)));
        assertThat(ReplayEngine.pairInteractions(frames)).isEmpty();
    }

    @Test
    void ignoresNotificationsOnBothSides() {
        List<CassetteFrame> frames = List.of(
                frame(Direction.C2S, JsonRpcMessage.notification("notifications/initialized", null)),
                frame(Direction.S2C, JsonRpcMessage.notification("notifications/progress", null)));
        assertThat(ReplayEngine.pairInteractions(frames)).isEmpty();
    }

    @Test
    void buildNoMatchErrorUsesInternalErrorNotMethodNotFound() {
        JsonRpcMessage err = ReplayEngine.buildNoMatchError(5);
        assertThat(err.error().code()).isEqualTo(-32603);
        assertThat(err.id()).isEqualTo(5);
    }

    private List<CassetteFrame> fetchFixture() {
        return List.of(
                frame(Direction.C2S, JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"))),
                frame(Direction.S2C, JsonRpcMessage.result(1, Map.of("ok", true))));
    }

    @Test
    void resolvesAStructuralMatchAndRewritesTheResponseId() {
        ReplayEngine engine = new ReplayEngine(fetchFixture());
        Optional<JsonRpcMessage> res = await(engine.resolve(
                JsonRpcMessage.request(999, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"))));

        assertThat(res).isPresent();
        assertThat(res.get().id()).isEqualTo(999);
        assertThat(res.get().result()).isEqualTo(Map.of("ok", true));
    }

    @Test
    void returnsEmptyForANotificationMatchedOrNot() {
        ReplayEngine engine = new ReplayEngine(fetchFixture());
        Optional<JsonRpcMessage> res = await(engine.resolve(
                JsonRpcMessage.notification("tools/call", Map.of("name", "fetch", "query", "best pizza near me"))));
        assertThat(res).isEmpty();
    }

    @Test
    void returnsANoMatchErrorForAnUnmatchedRequestWhenSemanticIsOff() {
        ReplayEngine engine = new ReplayEngine(fetchFixture());
        Optional<JsonRpcMessage> res = await(engine.resolve(
                JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "totally different"))));
        assertThat(res).isPresent();
        assertThat(res.get().error().code()).isEqualTo(-32603);
    }

    @Test
    void fallsBackToTheSemanticTierWhenEnabled() {
        ReplayEngine engine = new ReplayEngine(fetchFixture(), true, null);
        Optional<JsonRpcMessage> res = await(engine.resolve(
                JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near mee"))));
        assertThat(res).isPresent();
        assertThat(res.get().result()).isEqualTo(Map.of("ok", true));
    }

    @Test
    void doesNotFallBackToSemanticWhenDisabledEvenForACloseMatch() {
        ReplayEngine engine = new ReplayEngine(fetchFixture(), false, null);
        Optional<JsonRpcMessage> res = await(engine.resolve(
                JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near mee"))));
        assertThat(res).isPresent();
        assertThat(res.get().error().code()).isEqualTo(-32603);
    }

    @Test
    void recordedInteractionCountReflectsTheNumberOfPairedInteractions() {
        assertThat(new ReplayEngine(fetchFixture()).recordedInteractionCount()).isEqualTo(1);
    }

    @Test
    void byDefaultResolvesAnIdenticalRequestEveryTimeStateless() {
        ReplayEngine engine = new ReplayEngine(fetchFixture());
        JsonRpcMessage request = JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"));

        assertThat(await(engine.resolve(request)).get().result()).isEqualTo(Map.of("ok", true));
        assertThat(await(engine.resolve(request)).get().result()).isEqualTo(Map.of("ok", true));
    }

    @Test
    void withConsumeOnceASecondIdenticalRequestMissesOnceTheOneRecordedInteractionIsUsed() {
        ReplayEngine engine = new ReplayEngine(fetchFixture(), false, null, true);
        JsonRpcMessage request = JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"));

        assertThat(await(engine.resolve(request)).get().result()).isEqualTo(Map.of("ok", true));
        Optional<JsonRpcMessage> second = await(engine.resolve(request));
        assertThat(second.get().error().code()).isEqualTo(-32603);
    }

    @Test
    void withConsumeOnceAndTwoRecordedIdenticalInteractionsResolvesInRecordedOrderThenMisses() {
        List<CassetteFrame> twoInteractionFrames = List.of(
                frame(Direction.C2S, JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"))),
                frame(Direction.S2C, JsonRpcMessage.result(1, Map.of("page", "first"))),
                frame(Direction.C2S, JsonRpcMessage.request(2, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"))),
                frame(Direction.S2C, JsonRpcMessage.result(2, Map.of("page", "second"))));
        ReplayEngine engine = new ReplayEngine(twoInteractionFrames, false, null, true);
        JsonRpcMessage request = JsonRpcMessage.request(1, "tools/call", Map.of("name", "fetch", "query", "best pizza near me"));

        assertThat(await(engine.resolve(request)).get().result()).isEqualTo(Map.of("page", "first"));
        assertThat(await(engine.resolve(request)).get().result()).isEqualTo(Map.of("page", "second"));
        assertThat(await(engine.resolve(request)).get().error().code()).isEqualTo(-32603);
    }
}
