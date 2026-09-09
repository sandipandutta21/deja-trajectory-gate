package dev.deja.cli.gate;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.CassetteHeader;
import dev.deja.core.cassette.CassetteWriter;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.cassette.TransportType;
import dev.deja.core.redact.Redact;

import java.nio.file.Path;
import java.time.Instant;

/**
 * Opens a capture tee for a replay session: writes a fresh header, then every
 * inbound/outbound wire frame with capture-local timestamps and deja's standard deterministic
 * redaction applied. The golden cassette being replayed is never opened for writing here --
 * this is always a separate file.
 *
 * <p>Capture provenance (which redaction policy a golden was originally recorded with) isn't
 * tracked in the cassette header today, so this always applies deja's current deterministic
 * redaction policy rather than trying to infer one from the golden.
 * Mirrors the TypeScript implementation's {@code gate/capture.ts}.
 */
public final class Capture implements AutoCloseable {

    private final CassetteWriter writer;
    private final long startTime = System.currentTimeMillis();

    private Capture(CassetteWriter writer) {
        this.writer = writer;
    }

    public static Capture open(Path path, TransportType transport) {
        CassetteWriter writer = new CassetteWriter(path);
        writer.write(CassetteHeader.of(Instant.now().toString(), transport, null, null));
        return new Capture(writer);
    }

    public void record(Direction dir, JsonRpcMessage msg) {
        JsonRpcMessage redacted = Redact.redactMessage(msg);
        writer.write(CassetteFrame.of(dir, System.currentTimeMillis() - startTime, redacted));
    }

    @Override
    public void close() {
        writer.close();
    }
}
