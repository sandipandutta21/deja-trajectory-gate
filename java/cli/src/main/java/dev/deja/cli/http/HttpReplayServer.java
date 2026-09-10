package dev.deja.cli.http;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.deja.cli.gate.Capture;
import dev.deja.core.cassette.CassetteContents;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.cassette.TransportType;
import dev.deja.core.json.Json;
import dev.deja.core.replay.ReplayEngine;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Serves a recorded cassette as a spec-compliant MCP Streamable HTTP server: a single POST
 * endpoint, session-id issuance/validation, 202 Accepted for notification-only bodies, 405 for
 * GET, and JSON-RPC batch arrays. Mirrors the TypeScript implementation's {@code
 * transport/http/server.ts}.
 *
 * <p>Session-id note: the cassette format doesn't currently capture the headers a session was
 * originally recorded with, so replay mints and manages its own session ids rather than
 * replaying the recorded ones -- this satisfies the transport *contract* (issue on initialize,
 * reject unknown/expired ids) independent of what happened during recording.
 */
public final class HttpReplayServer implements AutoCloseable {

    private static final String JSON_CONTENT_TYPE = "application/json";
    private static final String SSE_CONTENT_TYPE = "text/event-stream";
    private static final String SESSION_HEADER = "mcp-session-id";

    /** Generous for any real JSON-RPC/MCP payload; exists to bound worst-case memory growth
     *  from a pathological or malicious body instead of buffering it in full. Mirrors the
     *  TypeScript implementation's {@code body.ts} `MAX_BODY_BYTES`. */
    private static final int MAX_BODY_BYTES = 10 * 1024 * 1024;

    private static final class BodyTooLargeException extends IOException {
        private static final long serialVersionUID = 1L;
    }

    /** Reads the request body up to {@code maxBytes}, throwing {@link BodyTooLargeException}
     *  (rather than continuing to buffer) the moment that's exceeded -- unlike {@code
     *  InputStream.readAllBytes()}, which has no such bound. */
    private static byte[] readBoundedBody(java.io.InputStream in, int maxBytes) throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int total = 0;
        int n;
        while ((n = in.read(chunk)) != -1) {
            total += n;
            if (total > maxBytes) {
                throw new BodyTooLargeException();
            }
            buffer.write(chunk, 0, n);
        }
        return buffer.toByteArray();
    }

    private final HttpServer server;
    private final ExecutorService executor;
    private final Capture capture;

    private HttpReplayServer(HttpServer server, ExecutorService executor, Capture capture) {
        this.server = server;
        this.executor = executor;
        this.capture = capture;
    }

    public int port() {
        return server.getAddress().getPort();
    }

    public static HttpReplayServer start(Path cassettePath, boolean semantic, int port, Path capturePath) throws IOException {
        CassetteContents contents = new CassetteReader(cassettePath).loadAll();
        ReplayEngine engine = new ReplayEngine(contents.frames(), semantic, null);
        Set<String> sessions = ConcurrentHashMap.newKeySet();
        Capture capture = capturePath != null ? Capture.open(capturePath, TransportType.HTTP) : null;

        HttpServer httpServer = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        ExecutorService executor = Executors.newCachedThreadPool();
        httpServer.setExecutor(executor);
        httpServer.createContext("/", exchange -> handle(exchange, engine, sessions, capture));
        httpServer.start();

        return new HttpReplayServer(httpServer, executor, capture);
    }

    private static void handle(HttpExchange exchange, ReplayEngine engine, Set<String> sessions, Capture capture) {
        try (exchange) {
            String method = exchange.getRequestMethod();

            if ("GET".equals(method)) {
                exchange.getResponseHeaders().add("Allow", "POST, DELETE");
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            if ("DELETE".equals(method)) {
                String sessionId = exchange.getRequestHeaders().getFirst(SESSION_HEADER);
                if (sessionId != null) {
                    sessions.remove(sessionId);
                }
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            if (!"POST".equals(method)) {
                exchange.getResponseHeaders().add("Allow", "POST, DELETE");
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
            if (contentType == null || !contentType.contains(JSON_CONTENT_TYPE)) {
                sendJson(exchange, 415, errorBody(-32700, "Deja: expected application/json body"));
                return;
            }

            String existingSession = exchange.getRequestHeaders().getFirst(SESSION_HEADER);
            if (existingSession != null && !sessions.contains(existingSession)) {
                sendJson(exchange, 404, errorBody(-32001, "Deja: unknown or expired session"));
                return;
            }

            byte[] requestBody;
            try {
                requestBody = readBoundedBody(exchange.getRequestBody(), MAX_BODY_BYTES);
            } catch (BodyTooLargeException e) {
                sendJson(exchange, 413, errorBody(-32600, "Deja: request body exceeds the " + MAX_BODY_BYTES + "-byte limit"));
                return;
            }

            JsonNode parsed;
            try {
                parsed = Json.MAPPER.readTree(requestBody);
            } catch (Exception e) {
                sendJson(exchange, 400, errorBody(-32700, "Deja: invalid JSON body"));
                return;
            }

            List<JsonRpcMessage> incoming = normalizeIncoming(parsed);
            if (capture != null) {
                for (JsonRpcMessage msg : incoming) {
                    capture.record(Direction.C2S, msg);
                }
            }

            List<JsonRpcMessage> responses = new ArrayList<>();
            boolean isInitialize = false;
            for (JsonRpcMessage msg : incoming) {
                if ("initialize".equals(msg.method())) {
                    isInitialize = true;
                }
                Optional<JsonRpcMessage> response = engine.resolve(msg).join();
                response.ifPresent(responses::add);
            }
            if (capture != null) {
                for (JsonRpcMessage response : responses) {
                    capture.record(Direction.S2C, response);
                }
            }

            String sessionId = existingSession;
            if (isInitialize) {
                sessionId = UUID.randomUUID().toString();
                sessions.add(sessionId);
            }
            if (sessionId != null) {
                exchange.getResponseHeaders().add(SESSION_HEADER, sessionId);
            }

            if (responses.isEmpty()) {
                // Every message in the body was a notification -- nothing to reply with.
                exchange.sendResponseHeaders(202, -1);
                return;
            }

            String acceptHeader = exchange.getRequestHeaders().getFirst("Accept");
            boolean wantsEventStream = acceptHeader != null && acceptHeader.contains(SSE_CONTENT_TYPE) && !acceptHeader.contains(JSON_CONTENT_TYPE);

            if (wantsEventStream) {
                exchange.getResponseHeaders().add("Content-Type", SSE_CONTENT_TYPE);
                exchange.sendResponseHeaders(200, 0);
                try (OutputStream os = exchange.getResponseBody()) {
                    for (JsonRpcMessage response : responses) {
                        os.write(formatSseEvent(response).getBytes(StandardCharsets.UTF_8));
                    }
                }
                return;
            }

            Object body = incoming.size() > 1 || parsed.isArray() ? responses : responses.get(0);
            sendJson(exchange, 200, body);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static List<JsonRpcMessage> normalizeIncoming(JsonNode parsed) throws IOException {
        List<JsonRpcMessage> messages = new ArrayList<>();
        if (parsed.isArray()) {
            for (JsonNode element : parsed) {
                messages.add(Json.MAPPER.treeToValue(element, JsonRpcMessage.class));
            }
        } else {
            messages.add(Json.MAPPER.treeToValue(parsed, JsonRpcMessage.class));
        }
        return messages;
    }

    private static Map<String, Object> errorBody(int code, String message) {
        return Map.of("jsonrpc", "2.0", "error", Map.of("code", code, "message", message));
    }

    private static void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] payload = Json.MAPPER.writeValueAsBytes(body);
        exchange.getResponseHeaders().add("Content-Type", JSON_CONTENT_TYPE);
        exchange.sendResponseHeaders(status, payload.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(payload);
        }
    }

    private static String formatSseEvent(Object payload) throws IOException {
        String json = Json.MAPPER.writeValueAsString(payload);
        StringBuilder sb = new StringBuilder();
        for (String line : json.split("\n", -1)) {
            sb.append("data: ").append(line).append('\n');
        }
        sb.append('\n');
        return sb.toString();
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdown();
        if (capture != null) {
            capture.close();
        }
    }
}
