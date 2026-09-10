import { MatchingTier } from "../core/types.js";
import { maxWeightAssignment } from "./hungarian.js";
import { scorePair } from "./pairing.js";
import { TrajectoryStep } from "./types.js";

export interface AlignedPair {
    goldenIndex?: number;
    actualIndex?: number;
    score?: number;
    tier?: MatchingTier;
    /** Set only by {@link annotateReorders}: this pair was originally two disconnected
     *  missing/added entries, merged because they'd have scored an accepted match against each
     *  other. Distinguishes "the DP genuinely matched this in place" from "these were relabeled
     *  after the fact" for {@link classifySequencePair}. */
    reordered?: boolean;
}

/** Derives a per-call acceptance weight that provably dominates: since every raw score is in
 *  [0,1], a value strictly greater than the number of steps being aligned always outweighs any
 *  achievable sum of non-accepted scores (plus the negligible indel-penalty total), so
 *  "maximize accepted matches" always outranks "maximize total score" in the scalarized
 *  objective -- for this call's actual input size, not an arbitrary constant sized for the
 *  largest input anyone might ever pass. */
function acceptedWeightFor(rowCount: number, colCount: number): number {
    return rowCount + colCount + 1;
}

/** Per-operation cost, small enough never to outweigh a single unit of score, present only to
 *  break ties toward fewer insertions/deletions. */
const INDEL_PENALTY = 1e-6;

/** Nudges tied weights toward lower golden/actual index, small enough
 *  never to outweigh a real score difference at this scale. */
const INDEX_TIEBREAK_EPSILON = 1e-9;

type Move = "match" | "delete" | "insert";

/**
 * Strict mode: ordered dynamic-programming sequence alignment. Every golden step is
 * either matched to exactly one actual step (in order) or reported missing; every actual step is
 * either matched or reported added. An eligible same-tool pair is always preferred as a match --
 * even scored 0 -- over reporting it as a disconnected add+missing (see `scorePair`).
 */
export function alignStrict(golden: TrajectoryStep[], actual: TrajectoryStep[], threshold: number): AlignedPair[] {
    const n = golden.length;
    const m = actual.length;
    const acceptedWeight = acceptedWeightFor(n, m);

    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    const choice: Move[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill("delete"));

    for (let i = 1; i <= n; i++) dp[i][0] = -i * INDEL_PENALTY;
    for (let j = 1; j <= m; j++) dp[0][j] = -j * INDEL_PENALTY;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const deleteValue = dp[i - 1][j] - INDEL_PENALTY;
            const insertValue = dp[i][j - 1] - INDEL_PENALTY;

            let best = deleteValue;
            let bestMove: Move = "delete";
            if (insertValue > best) {
                best = insertValue;
                bestMove = "insert";
            }

            const pair = scorePair(golden[i - 1], actual[j - 1], threshold);
            if (pair) {
                const goldenStep = golden[i - 1];
                const actualStep = actual[j - 1];
                const matchValue =
                    dp[i - 1][j - 1] +
                    (pair.accepted ? acceptedWeight : 0) +
                    pair.score -
                    INDEX_TIEBREAK_EPSILON * (goldenStep.index + actualStep.index);
                // Tie-break: a match is always preferred to leaving both sides unaligned.
                if (matchValue >= best) {
                    best = matchValue;
                    bestMove = "match";
                }
            }

            dp[i][j] = best;
            choice[i][j] = bestMove;
        }
    }

    const pairs: AlignedPair[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const move: Move = i === 0 ? "insert" : j === 0 ? "delete" : choice[i][j];
        if (move === "match") {
            const pair = scorePair(golden[i - 1], actual[j - 1], threshold)!;
            pairs.push({ goldenIndex: golden[i - 1].index, actualIndex: actual[j - 1].index, score: pair.score, tier: pair.tier });
            i--;
            j--;
        } else if (move === "delete") {
            pairs.push({ goldenIndex: golden[i - 1].index });
            i--;
        } else {
            pairs.push({ actualIndex: actual[j - 1].index });
            j--;
        }
    }

    return pairs.reverse();
}

function groupKey(step: TrajectoryStep): string {
    return `${step.method}␟${step.toolName ?? ""}`;
}

/**
 * Unordered mode: deterministic maximum-weight bipartite assignment, the basis
 * subset/superset also compare against. Eligibility (same method, same tool name) partitions
 * steps into independent groups -- cross-group matches never happen -- so each group is solved
 * as its own small complete-bipartite assignment problem rather than one global n*m matrix.
 */
export function alignUnordered(golden: TrajectoryStep[], actual: TrajectoryStep[], threshold: number): AlignedPair[] {
    const goldenGroups = new Map<string, TrajectoryStep[]>();
    const actualGroups = new Map<string, TrajectoryStep[]>();

    for (const step of golden) {
        const key = groupKey(step);
        if (!goldenGroups.has(key)) goldenGroups.set(key, []);
        goldenGroups.get(key)!.push(step);
    }
    for (const step of actual) {
        const key = groupKey(step);
        if (!actualGroups.has(key)) actualGroups.set(key, []);
        actualGroups.get(key)!.push(step);
    }

    const pairs: AlignedPair[] = [];

    for (const key of new Set([...goldenGroups.keys(), ...actualGroups.keys()])) {
        const g = goldenGroups.get(key) ?? [];
        const a = actualGroups.get(key) ?? [];

        if (g.length === 0) {
            for (const step of a) pairs.push({ actualIndex: step.index });
            continue;
        }
        if (a.length === 0) {
            for (const step of g) pairs.push({ goldenIndex: step.index });
            continue;
        }

        // Hungarian requires rows <= cols; transpose when the golden side of this group is larger.
        const transpose = g.length > a.length;
        const rows = transpose ? a : g;
        const cols = transpose ? g : a;
        const acceptedWeight = acceptedWeightFor(rows.length, cols.length);

        const weights = rows.map((rowStep) =>
            cols.map((colStep) => {
                const gStep = transpose ? colStep : rowStep;
                const aStep = transpose ? rowStep : colStep;
                const pair = scorePair(gStep, aStep, threshold)!; // eligible by construction (same group)
                return (pair.accepted ? acceptedWeight : 0) + pair.score - INDEX_TIEBREAK_EPSILON * (gStep.index + aStep.index);
            })
        );

        const assignment = maxWeightAssignment(weights);
        const matchedCols = new Set<number>();

        assignment.forEach((colIdx, rowIdx) => {
            matchedCols.add(colIdx);
            const gStep = transpose ? cols[colIdx] : rows[rowIdx];
            const aStep = transpose ? rows[rowIdx] : cols[colIdx];
            const pair = scorePair(gStep, aStep, threshold)!;
            pairs.push({ goldenIndex: gStep.index, actualIndex: aStep.index, score: pair.score, tier: pair.tier });
        });

        cols.forEach((step, idx) => {
            if (matchedCols.has(idx)) return;
            pairs.push(transpose ? { goldenIndex: step.index } : { actualIndex: step.index });
        });
    }

    pairs.sort((x, y) => {
        const gDiff = (x.goldenIndex ?? Infinity) - (y.goldenIndex ?? Infinity);
        if (gDiff !== 0) return gDiff;
        return (x.actualIndex ?? Infinity) - (y.actualIndex ?? Infinity);
    });

    return pairs;
}

/**
 * Post-processes a strict-mode alignment: a `missing` golden step and an `added`
 * actual step that would have scored an accepted match against each other are relabeled
 * from two disconnected entries into one `reordered` entry -- diagnostic only. `reordered` is
 * still a failure in strict mode; this never changes what passes or fails, only how it reads.
 *
 * Grouped by (method, toolName) exactly like {@link alignUnordered}, since a merge can only
 * ever be eligible within one group anyway; each group is its own small assignment problem so a
 * missing step is never merged with more than one added step, or vice versa.
 */
export function annotateReorders(
    pairs: AlignedPair[],
    golden: TrajectoryStep[],
    actual: TrajectoryStep[],
    threshold: number
): AlignedPair[] {
    const missingPositions: number[] = [];
    const addedPositions: number[] = [];
    pairs.forEach((pair, position) => {
        if (pair.goldenIndex !== undefined && pair.actualIndex === undefined) missingPositions.push(position);
        if (pair.actualIndex !== undefined && pair.goldenIndex === undefined) addedPositions.push(position);
    });
    if (missingPositions.length === 0 || addedPositions.length === 0) return pairs;

    const missingByGroup = new Map<string, number[]>();
    for (const position of missingPositions) {
        const key = groupKey(golden[pairs[position].goldenIndex!]);
        if (!missingByGroup.has(key)) missingByGroup.set(key, []);
        missingByGroup.get(key)!.push(position);
    }
    const addedByGroup = new Map<string, number[]>();
    for (const position of addedPositions) {
        const key = groupKey(actual[pairs[position].actualIndex!]);
        if (!addedByGroup.has(key)) addedByGroup.set(key, []);
        addedByGroup.get(key)!.push(position);
    }

    const mergePartner = new Map<number, number>();

    for (const [key, missingPosList] of missingByGroup) {
        const addedPosList = addedByGroup.get(key);
        if (!addedPosList) continue;

        const transpose = missingPosList.length > addedPosList.length;
        const rows = transpose ? addedPosList : missingPosList;
        const cols = transpose ? missingPosList : addedPosList;
        const acceptedWeight = acceptedWeightFor(rows.length, cols.length);

        const weights = rows.map((rowPos) =>
            cols.map((colPos) => {
                const missingPos = transpose ? colPos : rowPos;
                const addedPos = transpose ? rowPos : colPos;
                const pair = scorePair(golden[pairs[missingPos].goldenIndex!], actual[pairs[addedPos].actualIndex!], threshold)!;
                return (pair.accepted ? acceptedWeight : 0) + pair.score;
            })
        );

        const assignment = maxWeightAssignment(weights);
        assignment.forEach((colIdx, rowIdx) => {
            const missingPos = transpose ? cols[colIdx] : rows[rowIdx];
            const addedPos = transpose ? rows[rowIdx] : cols[colIdx];
            const pair = scorePair(golden[pairs[missingPos].goldenIndex!], actual[pairs[addedPos].actualIndex!], threshold)!;
            // Only an accepted (score >= threshold) pair reads as "clearly the same call,
            // just moved" -- otherwise this would misleadingly merge two calls to the same
            // tool that just happen to share a group, not a genuine reorder.
            if (pair.accepted) {
                mergePartner.set(missingPos, addedPos);
                mergePartner.set(addedPos, missingPos);
            }
        });
    }

    if (mergePartner.size === 0) return pairs;

    const result: AlignedPair[] = [];
    const emitted = new Set<number>();
    pairs.forEach((pair, position) => {
        if (emitted.has(position)) return;

        const partner = mergePartner.get(position);
        if (partner === undefined) {
            result.push(pair);
            return;
        }

        emitted.add(position);
        emitted.add(partner);
        const missingPos = pairs[position].goldenIndex !== undefined ? position : partner;
        const addedPos = pairs[position].actualIndex !== undefined ? position : partner;
        const goldenStep = golden[pairs[missingPos].goldenIndex!];
        const actualStep = actual[pairs[addedPos].actualIndex!];
        const scored = scorePair(goldenStep, actualStep, threshold)!;
        result.push({ goldenIndex: goldenStep.index, actualIndex: actualStep.index, score: scored.score, tier: scored.tier, reordered: true });
    });

    return result;
}
