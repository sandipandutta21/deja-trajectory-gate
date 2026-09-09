package dev.deja.cli;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * A deterministic stand-in for a real agent, spawned as a real subprocess by {@code
 * RunGateTest} -- proves {@code deja gate}'s HTTP server + process lifecycle against a genuine
 * separate JVM, not an in-process fake. Behavior selected by the first CLI argument.
 */
public final class FixtureAgentMain {

    private FixtureAgentMain() {
    }

    public static void main(String[] args) throws Exception {
        String behavior = args.length > 0 ? args[0] : "happy";
        String url = System.getenv("DEJA_MCP_URL");

        switch (behavior) {
            case "happy" -> {
                call(url, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
            }
            case "divergent" -> {
                call(url, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"unexpected\"}}");
            }
            case "failing" -> System.exit(7);
            case "hanging" -> Thread.sleep(Duration.ofSeconds(5).toMillis());
            default -> throw new IllegalArgumentException("Unknown behavior: " + behavior);
        }
    }

    private static void call(String url, String body) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IllegalStateException("Unexpected status " + response.statusCode() + ": " + response.body());
        }
    }
}
