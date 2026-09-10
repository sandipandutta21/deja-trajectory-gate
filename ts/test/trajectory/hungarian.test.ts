import { describe, it, expect } from "vitest";
import { maxWeightAssignment } from "../../src/trajectory/hungarian.js";

describe("maxWeightAssignment", () => {
    it("returns an empty assignment for zero rows", () => {
        expect(maxWeightAssignment([])).toEqual([]);
    });

    it("assigns every row -1 when there are no columns to assign to", () => {
        expect(maxWeightAssignment([[], [], []])).toEqual([-1, -1, -1]);
    });

    it("finds the hand-verifiable optimal assignment on a square matrix (diagonal dominates)", () => {
        // Diagonal sums to 15; any other permutation of a 3x3 has at most one diagonal-strength
        // entry and two weak ones, so it can't reach 15 -- verified by hand, not just "some" answer.
        const weights = [
            [5, 1, 1],
            [1, 5, 1],
            [1, 1, 5],
        ];
        expect(maxWeightAssignment(weights)).toEqual([0, 1, 2]);
    });

    it("finds the hand-verifiable optimal assignment on a rectangular (rows < cols) matrix", () => {
        // Optimal is (row0->col0, row1->col1) = 10; every other pairing tops out at 6.
        const weights = [
            [5, 1, 1],
            [1, 5, 1],
        ];
        expect(maxWeightAssignment(weights)).toEqual([0, 1]);
    });

    it("every row gets a distinct column (unique assignment)", () => {
        const weights = [
            [5, 1, 1],
            [1, 5, 1],
            [1, 1, 5],
        ];
        const assignment = maxWeightAssignment(weights);
        const usedCols = assignment.filter((c) => c >= 0);
        expect(new Set(usedCols).size).toBe(usedCols.length);
    });

    it("is deterministic on a fully-tied matrix -- same assignment every time, not just some valid one", () => {
        const weights = [
            [1, 1],
            [1, 1],
        ];
        const first = maxWeightAssignment(weights);
        for (let i = 0; i < 10; i++) {
            expect(maxWeightAssignment(weights)).toEqual(first);
        }
    });

    it("throws for a jagged (non-rectangular) matrix instead of silently corrupting the result", () => {
        expect(() => maxWeightAssignment([[1, 2], [1]])).toThrow(/rectangular/);
    });

    it("throws for a non-finite weight instead of silently corrupting the result", () => {
        expect(() => maxWeightAssignment([[1, NaN]])).toThrow(/finite/);
        expect(() => maxWeightAssignment([[1, Infinity]])).toThrow(/finite/);
    });

    it("throws when rows > cols, telling the caller to transpose", () => {
        expect(() => maxWeightAssignment([[1], [1]])).toThrow(/rows <= cols/);
    });
});
