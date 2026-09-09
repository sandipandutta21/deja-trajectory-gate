import { TrajectoryReport, TrajectoryStepReport } from "./types.js";

function omitUndefined<T extends object>(obj: T): Partial<T> {
    const out: Partial<T> = {};
    for (const key of Object.keys(obj) as (keyof T)[]) {
        if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
}

function canonicalStep(step: TrajectoryStepReport): Record<string, unknown> {
    return omitUndefined({
        goldenIndex: step.goldenIndex,
        actualIndex: step.actualIndex,
        outcome: step.outcome,
        method: step.method,
        toolName: step.toolName,
        score: step.score,
        tier: step.tier,
        phase: step.phase,
    });
}

/**
 * Explicit field order and no `undefined`-valued keys, independent of whatever
 * incidental construction order produced the report object -- so TypeScript and Java can emit
 * byte-identical canonical reports for the same input.
 */
export function toCanonicalReport(report: TrajectoryReport): Record<string, unknown> {
    return omitUndefined({
        reportVersion: report.reportVersion,
        mode: report.mode,
        threshold: report.threshold,
        steps: report.steps.map(canonicalStep),
        session: report.session ? omitUndefined(report.session) : undefined,
        summary: omitUndefined(report.summary),
    });
}

export function toCanonicalJson(report: TrajectoryReport): string {
    return JSON.stringify(toCanonicalReport(report), null, 2);
}

const OUTCOME_SYMBOL: Record<string, string> = {
    exact: "=",
    tolerated: "~",
    drifted: "!",
    added: "+",
    missing: "-",
    "required-satisfied": "=",
    "required-missing": "-",
    "prohibited-present": "!",
    "optional-observed": "~",
    "optional-absent": "?",
    reordered: "~",
};

function describeStep(step: TrajectoryStepReport): string {
    return step.toolName ? `${step.method} [${step.toolName}]` : step.method;
}

function annotate(step: TrajectoryStepReport, isFirstPostDivergence: boolean): string {
    if (step.phase === "post-divergence") {
        return isFirstPostDivergence ? "ROOT DIVERGENCE -- never served" : "POST-DIVERGENCE";
    }
    switch (step.outcome) {
        case "tolerated":
        case "drifted":
        case "reordered":
            return `${step.outcome} ${step.score?.toFixed(2)} ${step.tier}`;
        case "added":
            return "added";
        case "missing":
            return "missing";
        case "required-missing":
            return "REQUIRED, not observed";
        case "prohibited-present":
            return "PROHIBITED";
        case "optional-absent":
            return "optional, not observed";
        default:
            return "";
    }
}

/** Human-readable rendering of a canonical report. */
export function renderHumanReport(report: TrajectoryReport, title?: string): string {
    const lines: string[] = [];
    if (title) lines.push(`deja: trajectory gate -- ${title}`, "");

    let seenRootDivergence = false;
    report.steps.forEach((step, i) => {
        const symbol = OUTCOME_SYMBOL[step.outcome] ?? "?";
        const isFirstPostDivergence = step.phase === "post-divergence" && !seenRootDivergence;
        if (isFirstPostDivergence) seenRootDivergence = true;

        const note = annotate(step, isFirstPostDivergence);
        lines.push(`${i + 1}. ${symbol} ${describeStep(step)}${note ? `   ${note}` : ""}`);
    });

    lines.push("", "Result:");
    lines.push(`  exact: ${report.summary.exact}`);
    lines.push(`  tolerated: ${report.summary.tolerated}`);
    if (report.summary.drifted) lines.push(`  drifted: ${report.summary.drifted}`);
    if (report.summary.reordered) lines.push(`  reordered: ${report.summary.reordered}`);
    if (report.summary.added) lines.push(`  added: ${report.summary.added}`);
    if (report.summary.missing) lines.push(`  missing: ${report.summary.missing}`);
    if (report.summary.requiredMissing) lines.push(`  required missing: ${report.summary.requiredMissing}`);
    if (report.summary.prohibitedPresent) lines.push(`  prohibited present: ${report.summary.prohibitedPresent}`);
    if (report.session?.replayMisses) {
        const postDivergenceCount = report.steps.filter((s) => s.phase === "post-divergence").length - 1;
        lines.push("  root divergences: 1");
        lines.push(`  post-divergence observations: ${Math.max(postDivergenceCount, 0)}`);
    }

    lines.push("", report.summary.passed ? `PASS (mode=${report.mode})` : `FAIL -- behavior diverged (mode=${report.mode})`);

    return lines.join("\n");
}
