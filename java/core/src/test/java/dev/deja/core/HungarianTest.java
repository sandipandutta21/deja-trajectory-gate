package dev.deja.core;

import dev.deja.core.trajectory.Hungarian;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Mirrors the TS side's equivalent tests in {@code hungarian.test.ts}. */
class HungarianTest {

    @Test
    void returnsAnEmptyAssignmentForZeroRows() {
        assertThat(Hungarian.maxWeightAssignment(new double[0][0])).isEmpty();
    }

    @Test
    void assignsEveryRowMinusOneWhenThereAreNoColumnsToAssignTo() {
        assertThat(Hungarian.maxWeightAssignment(new double[][] {{}, {}, {}})).containsExactly(-1, -1, -1);
    }

    @Test
    void findsTheHandVerifiableOptimalAssignmentOnASquareMatrix() {
        // Diagonal sums to 15; any other permutation of a 3x3 has at most one diagonal-strength
        // entry and two weak ones, so it can't reach 15 -- verified by hand, not just "some" answer.
        double[][] weights = {
                {5, 1, 1},
                {1, 5, 1},
                {1, 1, 5},
        };
        assertThat(Hungarian.maxWeightAssignment(weights)).containsExactly(0, 1, 2);
    }

    @Test
    void findsTheHandVerifiableOptimalAssignmentOnARectangularMatrix() {
        // Optimal is (row0->col0, row1->col1) = 10; every other pairing tops out at 6.
        double[][] weights = {
                {5, 1, 1},
                {1, 5, 1},
        };
        assertThat(Hungarian.maxWeightAssignment(weights)).containsExactly(0, 1);
    }

    @Test
    void everyRowGetsADistinctColumn() {
        double[][] weights = {
                {5, 1, 1},
                {1, 5, 1},
                {1, 1, 5},
        };
        int[] assignment = Hungarian.maxWeightAssignment(weights);
        Set<Integer> usedCols = new HashSet<>();
        int usedCount = 0;
        for (int c : assignment) {
            if (c >= 0) {
                usedCols.add(c);
                usedCount++;
            }
        }
        assertThat(usedCols).hasSize(usedCount);
    }

    @Test
    void isDeterministicOnAFullyTiedMatrix() {
        double[][] weights = {
                {1, 1},
                {1, 1},
        };
        int[] first = Hungarian.maxWeightAssignment(weights);
        for (int i = 0; i < 10; i++) {
            assertThat(Hungarian.maxWeightAssignment(weights)).containsExactly(first);
        }
    }

    @Test
    void throwsForAJaggedMatrix() {
        assertThatThrownBy(() -> Hungarian.maxWeightAssignment(new double[][] {{1, 2}, {1}}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("rectangular");
    }

    @Test
    void throwsForANonFiniteWeight() {
        assertThatThrownBy(() -> Hungarian.maxWeightAssignment(new double[][] {{1, Double.NaN}}))
                .hasMessageContaining("finite");
        assertThatThrownBy(() -> Hungarian.maxWeightAssignment(new double[][] {{1, Double.POSITIVE_INFINITY}}))
                .hasMessageContaining("finite");
    }

    @Test
    void throwsWhenRowsExceedCols() {
        assertThatThrownBy(() -> Hungarian.maxWeightAssignment(new double[][] {{1}, {1}}))
                .hasMessageContaining("rows <= cols");
    }
}
