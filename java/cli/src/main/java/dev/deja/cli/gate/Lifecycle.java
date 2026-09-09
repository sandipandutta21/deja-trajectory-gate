package dev.deja.cli.gate;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Spawns the agent under test with {@code DEJA_MCP_URL} in its environment, inheriting this
 * process's stdio so the user sees the agent's own output live -- deja never parses it, the
 * agent talks MCP over HTTP to the replay server, not over this process's stdio.
 *
 * <p>Bounds the whole run with a timeout when given (graceful stop, then a forcible kill after
 * a fixed grace period), and forwards SIGINT/SIGTERM this JVM receives straight through to the
 * child via a shutdown hook, so {@code Ctrl+C} on {@code deja gate} doesn't orphan the agent
 * process. Mirrors the TypeScript implementation's {@code gate/lifecycle.ts}.
 */
public final class Lifecycle {

    /** Bounded grace period between a timeout's graceful stop and the follow-up forcible kill.
     *  Not user-configurable in v1 -- only the overall timeout is. */
    private static final long GRACE_MS = 5000;

    private Lifecycle() {
    }

    public record AgentRunResult(int exitCode, boolean timedOut) {
    }

    public static AgentRunResult runAgent(List<String> command, String mcpUrl, Long timeoutMs) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.environment().put("DEJA_MCP_URL", mcpUrl);
        builder.inheritIO();
        Process process = builder.start();

        Thread shutdownHook = new Thread(() -> stopGracefully(process));
        Runtime.getRuntime().addShutdownHook(shutdownHook);

        AtomicBoolean timedOut = new AtomicBoolean(false);
        Thread timeoutWatcher = null;
        if (timeoutMs != null) {
            timeoutWatcher = new Thread(() -> {
                try {
                    if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                        timedOut.set(true);
                        stopGracefully(process);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            timeoutWatcher.setDaemon(true);
            timeoutWatcher.start();
        }

        try {
            int exitCode = process.waitFor();
            return new AgentRunResult(exitCode, timedOut.get());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            stopGracefully(process);
            return new AgentRunResult(process.exitValue(), timedOut.get());
        } finally {
            if (timeoutWatcher != null) {
                timeoutWatcher.interrupt();
            }
            try {
                Runtime.getRuntime().removeShutdownHook(shutdownHook);
            } catch (IllegalStateException e) {
                // The JVM is already mid-shutdown (this IS the SIGINT/SIGTERM-forwarding path)
                // -- the hook either already ran or is running; nothing left to remove.
            }
        }
    }

    private static void stopGracefully(Process process) {
        if (!process.isAlive()) {
            return;
        }
        process.destroy();
        try {
            if (!process.waitFor(GRACE_MS, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        }
    }
}
