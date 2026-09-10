const INF = Infinity;

/**
 * Classic O(n^3) Hungarian algorithm (Kuhn-Munkres via successive shortest augmenting paths),
 * minimizing total cost over a rectangular matrix with `rows <= cols`. 1-indexed internally --
 * the standard formulation of this algorithm -- with 0 used as a sentinel "unassigned" row/col.
 */
function hungarianMinCost(cost: number[][]): number[] {
    const n = cost.length;
    const m = cost[0]?.length ?? 0;

    const u = new Array(n + 1).fill(0);
    const v = new Array(m + 1).fill(0);
    const p = new Array(m + 1).fill(0); // p[j] = row (1-indexed) currently assigned to column j
    const way = new Array(m + 1).fill(0);

    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array(m + 1).fill(INF);
        const used = new Array(m + 1).fill(false);

        do {
            used[j0] = true;
            const i0 = p[j0];
            let delta = INF;
            let j1 = -1;

            for (let j = 1; j <= m; j++) {
                if (used[j]) continue;
                const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }

            for (let j = 0; j <= m; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }

            j0 = j1;
        } while (p[j0] !== 0);

        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0 !== 0);
    }

    const rowAssignment = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) {
        if (p[j] > 0) rowAssignment[p[j] - 1] = j - 1;
    }
    return rowAssignment;
}

/**
 * Deterministic maximum-weight bipartite assignment: every row is matched to a distinct column
 * (rows <= cols required by the caller; transpose first otherwise), maximizing total weight.
 * Used by unordered/subset/superset alignment instead of a greedy best-match search,
 * so one highly-similar duplicate can't be consumed by two different rows.
 */
export function maxWeightAssignment(weights: number[][]): number[] {
    const rows = weights.length;
    if (rows === 0) return [];
    const cols = weights[0].length;
    if (cols === 0) return new Array(rows).fill(-1);
    if (rows > cols) {
        throw new Error("maxWeightAssignment requires rows <= cols; transpose before calling");
    }
    for (let i = 0; i < rows; i++) {
        if (weights[i].length !== cols) {
            throw new Error(`maxWeightAssignment requires a rectangular matrix -- row 0 has ${cols} columns, row ${i} has ${weights[i].length}`);
        }
        for (let j = 0; j < cols; j++) {
            if (!Number.isFinite(weights[i][j])) {
                throw new Error(`maxWeightAssignment requires finite weights -- weights[${i}][${j}] is ${weights[i][j]}`);
            }
        }
    }

    const cost = weights.map((row) => row.map((w) => -w));
    return hungarianMinCost(cost);
}
