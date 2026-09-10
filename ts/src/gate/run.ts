import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CassetteReader, CassetteWriter } from "../core/cassette.js";
import { startHttpReplayServer } from "../transport/http/server.js";
import { CassetteHeader } from "../core/types.js";
import { compareCassetteFrames } from "../trajectory/compare.js";
import { TrajectoryMode, TrajectoryPolicy, TrajectoryReport } from "../trajectory/types.js";
import { runAgent } from "./lifecycle.js";

export interface RunGateOptions {
    port?: number;
    mode?: TrajectoryMode;
    threshold?: number;
    policy?: TrajectoryPolicy;
    timeoutMs?: number;
    update?: boolean;
}

/** 0 pass, 1 behavior diverged, 2 CLI usage/config error (the CLI layer owns this one), 3
 *  harness/runtime failure. */
export type GateExitCode = 0 | 1 | 3;

/** Stable, machine-checkable identifier for *why* a harness failure happened -- so a CI
 *  consumer can branch on this instead of substring-matching `reason`'s free text, the same
 *  anti-pattern the no-match sentinel's error code already fixed on the replay side. One value
 *  per failure site in `runGate` below. */
export type GateFailureReasonCode =
    | "golden-read-failed"
    | "server-start-failed"
    | "spawn-failed"
    | "timeout"
    | "agent-exit-nonzero"
    | "capture-read-failed"
    | "no-capture"
    | "update-write-failed";

export interface RunGateResult {
    exitCode: GateExitCode;
    /** Absent when a harness failure (`reason`) happened before a comparison was possible. */
    report?: TrajectoryReport;
    /** Set only for harness failures (`exitCode: 3`) -- explains why, for the human/JSON report. */
    reason?: string;
    /** Set only for harness failures -- see `GateFailureReasonCode`. */
    reasonCode?: GateFailureReasonCode;
    updated?: boolean;
}

/** Rewrite that preserves the golden's own provenance fields (`server_command`/`target`
 *  describe the *original* upstream, still meaningful context even though this promoted
 *  cassette was captured via replay-and-tee rather than a live recording) while stamping a
 *  fresh `recorded_at`. The capture is already redacted by the capture tee itself. */
export async function promoteCapture(goldenPath: string, oldHeader: CassetteHeader, capturePath: string): Promise<void> {
    const { frames } = await new CassetteReader(capturePath).loadAll();
    const writer = new CassetteWriter(goldenPath);
    writer.write({
        type: "header",
        version: 1,
        recorded_at: new Date().toISOString(),
        transport: "http",
        server_command: oldHeader.server_command,
        target: oldHeader.target,
    });
    for (const frame of frames) writer.write(frame);
    await writer.close();
}

/**
 * `deja gate`'s supported v1 lifecycle: load golden, start the HTTP replay server with a
 * capture tee, spawn the agent with `DEJA_MCP_URL`, wait for it to finish (or time out), always
 * close the listener/flush the capture, then extract+compare the resulting trajectory.
 *
 * Pure-ish: returns a result rather than printing or exiting, same convention as the other
 * commands -- the CLI layer owns presentation and `process.exit`. The one side effect this
 * function itself performs is `--update`'s cassette rewrite, gated by safe-update preconditions.
 */
export async function runGate(goldenPath: string, command: string[], options: RunGateOptions = {}): Promise<RunGateResult> {
    let header;
    let goldenFrames;
    try {
        ({ header, frames: goldenFrames } = await new CassetteReader(goldenPath).loadAll());
    } catch (err) {
        return { exitCode: 3, reasonCode: "golden-read-failed", reason: `Unable to read golden cassette: ${(err as Error).message}` };
    }

    const capturePath = resolve(tmpdir(), `deja-gate-${randomUUID()}.jsonl`);

    let handle;
    try {
        handle = await startHttpReplayServer(goldenPath, { port: options.port, capture: capturePath });
    } catch (err) {
        return { exitCode: 3, reasonCode: "server-start-failed", reason: `Replay server failed to start: ${(err as Error).message}` };
    }

    let agentResult;
    try {
        const { done } = runAgent(command, `http://127.0.0.1:${handle.port}`, options.timeoutMs);
        agentResult = await done;
    } catch (err) {
        await handle.close();
        await unlink(capturePath).catch(() => {});
        return { exitCode: 3, reasonCode: "spawn-failed", reason: `Failed to spawn agent command: ${(err as Error).message}` };
    }

    // Every exit path from here closes the listener and flushes the capture.
    await handle.close();

    try {
        if (agentResult.timedOut) {
            return { exitCode: 3, reasonCode: "timeout", reason: `Agent timed out after ${options.timeoutMs}ms; capture may be incomplete.` };
        }
        if (agentResult.exitCode !== 0) {
            const signalNote = agentResult.signal ? ` (signal ${agentResult.signal})` : "";
            return { exitCode: 3, reasonCode: "agent-exit-nonzero", reason: `Agent exited with code ${agentResult.exitCode}${signalNote}.` };
        }

        let actualFrames;
        try {
            ({ frames: actualFrames } = await new CassetteReader(capturePath).loadAll());
        } catch (err) {
            return { exitCode: 3, reasonCode: "capture-read-failed", reason: `No usable capture: ${(err as Error).message}` };
        }

        if (actualFrames.length === 0) {
            return { exitCode: 3, reasonCode: "no-capture", reason: "No frames captured -- the agent never connected to DEJA_MCP_URL." };
        }

        const report = compareCassetteFrames(goldenFrames, actualFrames, {
            mode: options.mode,
            threshold: options.threshold,
            policy: options.policy,
        });

        let updated = false;
        if (options.update && (report.session?.replayMisses ?? 0) === 0) {
            try {
                await promoteCapture(goldenPath, header, capturePath);
                updated = true;
            } catch (err) {
                return { exitCode: 3, reasonCode: "update-write-failed", reason: `Failed to update golden cassette: ${(err as Error).message}` };
            }
        }

        return { exitCode: report.summary.passed ? 0 : 1, report, updated };
    } finally {
        await unlink(capturePath).catch(() => {});
    }
}
