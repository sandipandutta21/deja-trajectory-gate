#!/usr/bin/env node
import { parseArgs } from "node:util";
import { diffCassettes } from "./command/diff.js";
import { parseDurationMs, runGate } from "./command/gate.js";
import { recordHttp, recordStdio } from "./command/record.js";
import { runClean, runScan } from "./command/redact.js";
import { replayHttp, replayStdio } from "./command/replay.js";
import { compareTrajectoryCassettes, deriveTrajectoryPolicy, readTrajectoryPolicy } from "./command/trajectory.js";
import { DiffReport, VerifyReport } from "./core/types.js";
import { verifyCassette } from "./command/verify.js";
import { renderHumanReport, toCanonicalJson } from "./trajectory/report.js";
import { TrajectoryMode } from "./trajectory/types.js";

const args = process.argv.slice(2);

const TRAJECTORY_MODES: TrajectoryMode[] = ["strict", "unordered", "subset", "superset", "policy"];

function printUsage(): void {
    console.error("Usage: deja <command> [options]");
    console.error("Commands: record, replay, verify, diff, redact, trajectory, gate");
}

if (args.length === 0) {
    printUsage();
    process.exit(1);
}

const command = args[0];
const commandArgs = args.slice(1);

/** Splits `... --flag value -- server cmd args` into the deja-facing flags and the
 *  passthrough command, the convention every subcommand that spawns a server shares. */
function splitOnDashDash(rawArgs: string[]): { before: string[]; after: string[] } {
    const index = rawArgs.indexOf("--");
    if (index === -1) return { before: rawArgs, after: [] };
    return { before: rawArgs.slice(0, index), after: rawArgs.slice(index + 1) };
}

function printVerifyReport(report: VerifyReport, updated: boolean): void {
    console.log(`Deja: checked ${report.checked}/${report.totalRequests} recorded request(s) against the live
  server.`);

    for (const diff of report.differences) {
        console.error(`\n[DIFF] request id ${JSON.stringify(diff.requestId)} (${diff.method ?? "unknown method"})`);
        console.error("  expected:", JSON.stringify(diff.expected));
        console.error("  received:", JSON.stringify(diff.received));
    }

    if (updated) {
        console.log(`Deja: cassette updated with ${report.checked} live response(s).`);
    } else if (report.differences.length > 0) {
        console.error(`\nVerify failed: ${report.differences.length} difference(s) found.`);
    } else {
        console.log("Verify passed: zero structural drift detected.");
    }
}

function printDiffReport(report: DiffReport): void {
    for (const change of report.changes) {
        console.log(`[${change.severity.toUpperCase()}] ${change.message}`);
    }
    console.log(`\nResult: ${report.breakingCount} breaking, ${report.minorCount} minor`);
}

async function main(): Promise<void> {
    switch (command) {
        case "record": {
            const { before, after } = splitOnDashDash(commandArgs);
            const { values } = parseArgs({
                args: before,
                options: {
                    output: { type: "string", short: "o" },
                    target: { type: "string" },
                    port: { type: "string" },
                    "no-redact": { type: "boolean" },
                },
                allowPositionals: true,
            });

            const out = values.output || "session.cassette.jsonl";
            const noRedact = !!values["no-redact"];
            const port = values.port ? Number(values.port) : undefined;

            if (values.target) {
                await recordHttp(values.target, out, { port, noRedact });
            } else if (after.length > 0) {
                await recordStdio(after, out, noRedact);
            } else {
                console.error("Error: Provide a server command after '--' " +
                    "(e.g., deja record -o out.jsonl -- nodeserver.js)");
                console.error("       or --target <url> to record a Streamable HTTP server instead.");
                process.exit(1);
            }
            break;
        }
        case "replay": {
            const { values, positionals } = parseArgs({
                args: commandArgs,
                options: {
                    semantic: { type: "boolean" },
                    port: { type: "string" },
                    capture: { type: "string" },
                },
                allowPositionals: true,
            });

            const cassettePath = positionals[0];
            if (!cassettePath) {
                console.error("Error: Provide a cassette path (e.g., deja replay session.cassette.jsonl)");
                process.exit(1);
            }

            const semantic = !!values.semantic;
            const capture = values.capture;

            // Presence of --port picks the HTTP replay server; its absence means stdio --
            // independent of how the cassette was originally recorded (cross-transport replay).
            if (values.port !== undefined) {
                await replayHttp(cassettePath, { semantic, port: Number(values.port), capture });
            } else {
                await replayStdio(cassettePath, { semantic, capture });
            }
            break;
        }
        case "verify": {
            const { before, after } = splitOnDashDash(commandArgs);
            const { values, positionals } = parseArgs({
                args: before,
                options: {
                    "ignore-fields": { type: "string", multiple: true },
                    "ignore-paths": { type: "string", multiple: true },
                    update: { type: "boolean" },
                },
                allowPositionals: true,
            });

            const cassettePath = positionals[0];
            if (!cassettePath) {
                console.error("Error: Provide a cassette path " +
                    "(e.g., deja verify session.cassette.jsonl -- nodeserver.js)");
                process.exit(1);
            }

            const update = !!values.update;
            const report = await verifyCassette(cassettePath, after, {
                ignoreFields: values["ignore-fields"] ?? [],
                ignorePaths: values["ignore-paths"] ?? [],
                update,
            });

            printVerifyReport(report, update);
            if (!update && report.differences.length > 0) process.exit(1);
            break;
        }
        case "diff": {
            const { values, positionals } = parseArgs({
                args: commandArgs,
                options: {
                    "fail-on-breaking": { type: "boolean" },
                },
                allowPositionals: true,
            });

            if (positionals.length < 2) {
                console.error("Error: Provide two cassette paths to diff (e.g., deja diff v1.jsonl v2.jsonl)");
                process.exit(1);
            }

            const report = await diffCassettes(positionals[0], positionals[1]);
            printDiffReport(report);
            if (values["fail-on-breaking"] && report.breakingCount > 0) process.exit(1);
            break;
        }
        case "trajectory": {
            const { values, positionals } = parseArgs({
                args: commandArgs,
                options: {
                    mode: { type: "string" },
                    policy: { type: "string" },
                    "derive-policy": { type: "string" },
                    threshold: { type: "string" },
                    include: { type: "string", multiple: true },
                    json: { type: "boolean" },
                },
                allowPositionals: true,
            });

            const goldenPath = positionals[0];
            if (!goldenPath) {
                console.error("Error: Provide a golden cassette path " +
                    "(e.g., deja trajectory golden.jsonl actual.jsonl)");
                process.exit(1);
            }

            if (values["derive-policy"]) {
                const outputPath = values["derive-policy"];
                await deriveTrajectoryPolicy(goldenPath, outputPath);
                console.log(`Deja: wrote a starting policy to ${outputPath}.`);
                break;
            }

            const actualPath = positionals[1];
            if (!actualPath) {
                console.error("Error: Provide an actual cassette path " +
                    "(e.g., deja trajectory golden.jsonl actual.jsonl)");
                process.exit(1);
            }

            const mode = (values.mode as TrajectoryMode | undefined) ?? "strict";
            if (!TRAJECTORY_MODES.includes(mode)) {
                console.error(`Error: --mode must be one of ${TRAJECTORY_MODES.join(", ")}`);
                process.exit(1);
            }

            if (mode === "policy" && !values.policy) {
                console.error("Error: --mode policy requires --policy <policy.json>");
                process.exit(1);
            }

            const report = await compareTrajectoryCassettes(goldenPath, actualPath, {
                mode,
                threshold: values.threshold ? Number(values.threshold) : undefined,
                include: values.include ?? [],
                policy: values.policy ? await readTrajectoryPolicy(values.policy) : undefined,
            });

            console.log(values.json ? toCanonicalJson(report) : renderHumanReport(report, goldenPath));
            if (!report.summary.passed) process.exit(1);
            break;
        }
        case "gate": {
            const { before, after } = splitOnDashDash(commandArgs);
            const { values, positionals } = parseArgs({
                args: before,
                options: {
                    port: { type: "string" },
                    mode: { type: "string" },
                    policy: { type: "string" },
                    threshold: { type: "string" },
                    timeout: { type: "string" },
                    json: { type: "boolean" },
                    update: { type: "boolean" },
                },
                allowPositionals: true,
            });

            const goldenPath = positionals[0];
            if (!goldenPath) {
                console.error("Error: Provide a golden cassette path (e.g., deja gate golden.jsonl -- node agent.js)");
                process.exit(2);
            }
            if (after.length === 0) {
                console.error("Error: Provide an agent command after '--' (e.g., deja gate golden.jsonl -- node agent.js)");
                process.exit(2);
            }

            const mode = (values.mode as TrajectoryMode | undefined) ?? "strict";
            if (!TRAJECTORY_MODES.includes(mode)) {
                console.error(`Error: --mode must be one of ${TRAJECTORY_MODES.join(", ")}`);
                process.exit(2);
            }
            if (mode === "policy" && !values.policy) {
                console.error("Error: --mode policy requires --policy <policy.json>");
                process.exit(2);
            }

            let timeoutMs: number | undefined;
            try {
                timeoutMs = values.timeout ? parseDurationMs(values.timeout) : undefined;
            } catch (err) {
                console.error(`Error: ${(err as Error).message}`);
                process.exit(2);
            }

            const result = await runGate(goldenPath, after, {
                port: values.port ? Number(values.port) : undefined,
                mode,
                threshold: values.threshold ? Number(values.threshold) : undefined,
                policy: values.policy ? await readTrajectoryPolicy(values.policy) : undefined,
                timeoutMs,
                update: !!values.update,
            });

            if (result.report) {
                console.log(values.json ? toCanonicalJson(result.report) : renderHumanReport(result.report, goldenPath));
                if (result.updated) console.log("Deja: golden cassette updated with the captured session.");
            } else {
                console.error(`Deja gate: harness failure -- ${result.reason}`);
            }

            process.exit(result.exitCode);
            break;
        }
        case "redact": {
            const { values, positionals } = parseArgs({
                args: commandArgs,
                options: {
                    scan: { type: "boolean" },
                    output: { type: "string", short: "o" },
                },
                allowPositionals: true,
            });

            if (values.scan) {
                if (positionals.length === 0) {
                    console.error("Error: Provide one or more cassette paths to scan " +
                        "(e.g., deja redact --scansession.cassette.jsonl)");
                    process.exit(1);
                }
                await runScan(positionals);
            } else {
                const input = positionals[0];
                if (!input || !values.output) {
                    console.error("Error: Provide an input cassette and -o <output> " +
                        "(e.g., deja redact -o clean.jsonlsession.cassette.jsonl)");
                    process.exit(1);
                }
                await runClean(input, values.output);
            }
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});