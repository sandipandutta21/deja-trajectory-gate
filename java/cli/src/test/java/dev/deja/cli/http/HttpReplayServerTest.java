package dev.deja.cli.http;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.CassetteHeader;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.cassette.CassetteWriter;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.cassette.TransportType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

class HttpReplayServerTest {

    @TempDir
    Path tempDir;

    private final HttpClient client = HttpClient.newHttpClient();

    private Path writeGolden() {
        Path path = tempDir.resolve("golden.jsonl");
        try (CassetteWriter writer = new CassetteWriter(path)) {
            writer.write(CassetteHeader.of(Instant.now().toString(), TransportType.HTTP, null, null));
            writer.write(CassetteFrame.of(Direction.C2S, 0, JsonRpcMessage.request(1, "initialize", null)));
            writer.write(CassetteFrame.of(Direction.S2C, 1, JsonRpcMessage.result(1, java.util.Map.of("capabilities", java.util.Map.of()))));
            writer.write(CassetteFrame.of(Direction.C2S, 2, JsonRpcMessage.request(2, "tools/list", null)));
            writer.write(CassetteFrame.of(Direction.S2C, 3, JsonRpcMessage.result(2, java.util.Map.of("tools", java.util.List.of()))));
        }
        return path;
    }

    private HttpResponse<String> post(int port, String body, String... headers) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        for (int i = 0; i + 1 < headers.length; i += 2) {
            builder.header(headers[i], headers[i + 1]);
        }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void answersAStructurallyMatchingRequestAndIssuesASessionOnInitialize() throws Exception {
        try (HttpReplayServer server = HttpReplayServer.start(writeGolden(), false, 0, null)) {
            HttpResponse<String> response = post(server.port(), "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}");
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.body()).contains("\"capabilities\"");
            assertThat(response.headers().firstValue("mcp-session-id")).isPresent();
        }
    }

    @Test
    void rejectsAnUnknownSessionId() throws Exception {
        try (HttpReplayServer server = HttpReplayServer.start(writeGolden(), false, 0, null)) {
            HttpResponse<String> response = post(server.port(), "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}", "mcp-session-id", "not-a-real-session");
            assertThat(response.statusCode()).isEqualTo(404);
        }
    }

    @Test
    void responds413AndStopsReadingInsteadOfBufferingForeverForAnOversizedBody() throws Exception {
        try (HttpReplayServer server = HttpReplayServer.start(writeGolden(), false, 0, null)) {
            String oversized = "x".repeat(10 * 1024 * 1024 + 1);
            HttpResponse<String> response = post(server.port(), oversized);
            assertThat(response.statusCode()).isEqualTo(413);
        }
    }

    @Test
    void rejectsGetWith405() throws Exception {
        try (HttpReplayServer server = HttpReplayServer.start(writeGolden(), false, 0, null)) {
            HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.port())).GET().build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(405);
        }
    }

    @Test
    void returnsANoMatchErrorForAnUnrecordedRequestAndTeesItIntoTheCapture() throws Exception {
        Path capturePath = tempDir.resolve("actual.jsonl");
        try (HttpReplayServer server = HttpReplayServer.start(writeGolden(), false, 0, capturePath)) {
            HttpResponse<String> response = post(server.port(), "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"unrecorded\"}}");
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.body()).contains("No matching recorded request");
        }

        var frames = new CassetteReader(capturePath).loadAll().frames();
        assertThat(frames).anySatisfy(f -> assertThat(f.msg().method()).isEqualTo("tools/call"));
        assertThat(frames).anySatisfy(f -> assertThat(f.msg().error()).isNotNull());
    }
}
