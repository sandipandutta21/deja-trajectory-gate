package dev.deja.core.trajectory;

import lombok.experimental.UtilityClass;

import java.util.Arrays;

/** Mirrors the TypeScript implementation's {@code hungarian.ts}. */
@UtilityClass
public class Hungarian {

    private final double INF = Double.POSITIVE_INFINITY;

    /**
     * Classic O(n^3) Hungarian algorithm (Kuhn-Munkres via successive shortest augmenting
     * paths), minimizing total cost over a rectangular matrix with {@code rows <= cols}.
     * 1-indexed internally -- the standard formulation of this algorithm -- with 0 used as a
     * sentinel "unassigned" row/col.
     */
    private int[] hungarianMinCost(double[][] cost) {
        int n = cost.length;
        int m = n == 0 ? 0 : cost[0].length;

        double[] u = new double[n + 1];
        double[] v = new double[m + 1];
        int[] p = new int[m + 1]; // p[j] = row (1-indexed) currently assigned to column j
        int[] way = new int[m + 1];

        for (int i = 1; i <= n; i++) {
            p[0] = i;
            int j0 = 0;
            double[] minv = new double[m + 1];
            Arrays.fill(minv, INF);
            boolean[] used = new boolean[m + 1];

            do {
                used[j0] = true;
                int i0 = p[j0];
                double delta = INF;
                int j1 = -1;

                for (int j = 1; j <= m; j++) {
                    if (used[j]) {
                        continue;
                    }
                    double cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                    if (cur < minv[j]) {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if (minv[j] < delta) {
                        delta = minv[j];
                        j1 = j;
                    }
                }

                for (int j = 0; j <= m; j++) {
                    if (used[j]) {
                        u[p[j]] += delta;
                        v[j] -= delta;
                    } else {
                        minv[j] -= delta;
                    }
                }

                j0 = j1;
            } while (p[j0] != 0);

            do {
                int j1 = way[j0];
                p[j0] = p[j1];
                j0 = j1;
            } while (j0 != 0);
        }

        int[] rowAssignment = new int[n];
        Arrays.fill(rowAssignment, -1);
        for (int j = 1; j <= m; j++) {
            if (p[j] > 0) {
                rowAssignment[p[j] - 1] = j - 1;
            }
        }
        return rowAssignment;
    }

    /**
     * Deterministic maximum-weight bipartite assignment: every row is matched to a distinct
     * column (rows {@code <=} cols required by the caller; transpose first otherwise),
     * maximizing total weight. Used by unordered/subset/superset alignment instead
     * of a greedy best-match search, so one highly-similar duplicate can't be consumed by two
     * different rows.
     */
    public int[] maxWeightAssignment(double[][] weights) {
        int rows = weights.length;
        if (rows == 0) {
            return new int[0];
        }
        int cols = weights[0].length;
        if (cols == 0) {
            int[] none = new int[rows];
            Arrays.fill(none, -1);
            return none;
        }
        if (rows > cols) {
            throw new IllegalArgumentException("maxWeightAssignment requires rows <= cols; transpose before calling");
        }

        double[][] cost = new double[rows][cols];
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                cost[i][j] = -weights[i][j];
            }
        }
        return hungarianMinCost(cost);
    }
}
