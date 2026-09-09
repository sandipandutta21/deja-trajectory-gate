import { CassetteWriter } from "../core/cassette.js";
import { redactObject } from "../core/redact.js";
import { CassetteFrame, Direction, JsonRpcMessage, TransportType } from "../core/types.js";

export interface ReplayCapture {
    record(dir: Direction, msg: JsonRpcMessage): void;
    close(): Promise<void>;
}

/**
 * Opens a capture tee for a replay session: writes a fresh header, then every inbound/outbound
 * wire frame with capture-local timestamps, redacted the same way `deja record` redacts a live
 * session. The golden cassette being replayed is never opened for writing here -- this is
 * always a separate file.
 *
 * Capture provenance (which redaction policy a golden was originally recorded with) isn't
 * tracked in the cassette header today, so this always applies deja's current deterministic
 * redaction policy rather than trying to infer one from the golden.
 */
export function openCapture(path: string, transport: TransportType): ReplayCapture {
    const writer = new CassetteWriter(path);
    writer.write({ type: "header", version: 1, recorded_at: new Date().toISOString(), transport });
    const startTime = Date.now();

    return {
        record(dir: Direction, msg: JsonRpcMessage): void {
            const frame: CassetteFrame = {
                type: "frame",
                dir,
                t_ms: Date.now() - startTime,
                msg: redactObject(msg) as JsonRpcMessage,
            };
            writer.write(frame);
        },
        close: () => writer.close(),
    };
}
