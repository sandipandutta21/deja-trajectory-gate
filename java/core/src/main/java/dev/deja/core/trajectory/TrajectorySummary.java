package dev.deja.core.trajectory;

public record TrajectorySummary(
        boolean passed,
        int exact,
        int tolerated,
        int drifted,
        int reordered,
        int added,
        int missing,
        int requiredMissing,
        int prohibitedPresent) {
}
