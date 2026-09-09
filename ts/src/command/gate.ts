import { runGate, RunGateOptions, RunGateResult } from "../gate/run.js";

export type { RunGateOptions, RunGateResult };
export { runGate };

/** Parses `--timeout`: a bare number of milliseconds, or a number suffixed with `s`/`m`
 *  (`"30s"`, `"2m"`). Throws on anything else -- a CLI usage error, not a harness failure. */
export function parseDurationMs(raw: string): number {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(raw.trim());
    if (!match) throw new Error(`Invalid duration "${raw}" (expected e.g. "30s", "2m", or a plain millisecond count)`);

    const value = Number(match[1]);
    switch (match[2]) {
        case "m":
            return value * 60_000;
        case "s":
            return value * 1_000;
        default:
            return value;
    }
}
