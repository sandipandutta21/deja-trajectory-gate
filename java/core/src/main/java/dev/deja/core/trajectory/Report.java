package dev.deja.core.trajectory;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.deja.core.json.Json;
import lombok.experimental.UtilityClass;

import java.util.List;
import java.util.Map;

/** Mirrors the TypeScript implementation's {@code report.ts}. */
@UtilityClass
public class Report {

    /** Whole-number scores/thresholds serialize without a trailing {@code .0} (matching
     *  JavaScript's {@code JSON.stringify(1)} => {@code "1"}), everything else as a plain
     *  double -- Jackson's boxed-{@code Double} POJO serialization always emits the decimal
     *  point, which byte-identical cross-language conformance can't tolerate. */
    private void putNumber(ObjectNode node, String field, double value) {
        // (int), not (long): scores/thresholds are always in a small range, and Jackson's own
        // JSON parser picks IntNode (not LongNode) for a small integral literal like "1" -- an
        // IntNode and a LongNode holding the same value are still NOT JsonNode#equals(), which
        // is exactly what compares "actual" against a fixture's parsed "expected" tree.
        if (value == Math.rint(value) && !Double.isInfinite(value)) {
            node.put(field, (int) value);
        } else {
            node.put(field, value);
        }
    }

    private ObjectNode canonicalStep(TrajectoryStepReport step) {
        ObjectNode node = Json.MAPPER.createObjectNode();
        if (step.goldenIndex() != null) {
            node.put("goldenIndex", step.goldenIndex());
        }
        if (step.actualIndex() != null) {
            node.put("actualIndex", step.actualIndex());
        }
        node.put("outcome", step.outcome().wireValue());
        node.put("method", step.method());
        if (step.toolName() != null) {
            node.put("toolName", step.toolName());
        }
        if (step.score() != null) {
            putNumber(node, "score", step.score());
        }
        if (step.tier() != null) {
            node.put("tier", step.tier().wireValue());
        }
        if (step.phase() != null) {
            node.put("phase", step.phase().wireValue());
        }
        return node;
    }

    /**
     * Explicit field order and no null-valued keys, independent of whatever
     * incidental construction order produced the report object -- so TypeScript and Java can
     * emit byte-identical canonical reports for the same input.
     */
    public ObjectNode toCanonicalReport(TrajectoryReport report) {
        ObjectNode node = Json.MAPPER.createObjectNode();
        node.put("reportVersion", report.reportVersion());
        node.put("mode", report.mode().wireValue());
        putNumber(node, "threshold", report.threshold());

        ArrayNode steps = Json.MAPPER.createArrayNode();
        for (TrajectoryStepReport step : report.steps()) {
            steps.add(canonicalStep(step));
        }
        node.set("steps", steps);

        if (report.session() != null) {
            ObjectNode session = Json.MAPPER.createObjectNode();
            session.put("replayMisses", report.session().replayMisses());
            if (report.session().firstMissFrameIndex() != null) {
                session.put("firstMissFrameIndex", report.session().firstMissFrameIndex());
            }
            node.set("session", session);
        }

        ObjectNode summary = Json.MAPPER.createObjectNode();
        summary.put("passed", report.summary().passed());
        summary.put("exact", report.summary().exact());
        summary.put("tolerated", report.summary().tolerated());
        summary.put("drifted", report.summary().drifted());
        summary.put("reordered", report.summary().reordered());
        summary.put("added", report.summary().added());
        summary.put("missing", report.summary().missing());
        summary.put("requiredMissing", report.summary().requiredMissing());
        summary.put("prohibitedPresent", report.summary().prohibitedPresent());
        node.set("summary", summary);

        return node;
    }

    private void indent(StringBuilder sb, int depth) {
        sb.append("  ".repeat(depth));
    }

    /** Hand-rolled pretty printer rather than Jackson's own {@code DefaultPrettyPrinter} --
     *  Jackson's default writes {@code " : "} (space before the colon), which does not match
     *  JavaScript's {@code JSON.stringify(value, null, 2)} ({@code ": "}); byte-identical
     *  cross-language conformance needs the same convention on both sides. Leaf values (every
     *  string/number/boolean already appearing only where this class itself put it, via {@link
     *  #canonicalStep}/{@link #toCanonicalReport}) are still serialized through Jackson's own
     *  {@code JsonNode#toString()}, so string escaping and number formatting stay standard.
     */
    private void writeNode(com.fasterxml.jackson.databind.JsonNode node, StringBuilder sb, int depth) {
        if (node.isObject()) {
            if (node.isEmpty()) {
                sb.append("{}");
                return;
            }
            sb.append("{\n");
            var fields = node.properties().iterator();
            while (fields.hasNext()) {
                var entry = fields.next();
                indent(sb, depth + 1);
                sb.append('"').append(entry.getKey()).append("\": ");
                writeNode(entry.getValue(), sb, depth + 1);
                if (fields.hasNext()) {
                    sb.append(',');
                }
                sb.append('\n');
            }
            indent(sb, depth);
            sb.append('}');
        } else if (node.isArray()) {
            if (node.isEmpty()) {
                sb.append("[]");
                return;
            }
            sb.append("[\n");
            for (int i = 0; i < node.size(); i++) {
                indent(sb, depth + 1);
                writeNode(node.get(i), sb, depth + 1);
                if (i < node.size() - 1) {
                    sb.append(',');
                }
                sb.append('\n');
            }
            indent(sb, depth);
            sb.append(']');
        } else {
            sb.append(node.toString());
        }
    }

    public String toCanonicalJson(TrajectoryReport report) {
        StringBuilder sb = new StringBuilder();
        writeNode(toCanonicalReport(report), sb, 0);
        return sb.toString();
    }

    private final Map<StepOutcome, String> OUTCOME_SYMBOL = Map.ofEntries(
            Map.entry(StepOutcome.EXACT, "="),
            Map.entry(StepOutcome.TOLERATED, "~"),
            Map.entry(StepOutcome.DRIFTED, "!"),
            Map.entry(StepOutcome.ADDED, "+"),
            Map.entry(StepOutcome.MISSING, "-"),
            Map.entry(StepOutcome.REQUIRED_SATISFIED, "="),
            Map.entry(StepOutcome.REQUIRED_MISSING, "-"),
            Map.entry(StepOutcome.PROHIBITED_PRESENT, "!"),
            Map.entry(StepOutcome.OPTIONAL_OBSERVED, "~"),
            Map.entry(StepOutcome.OPTIONAL_ABSENT, "?"),
            Map.entry(StepOutcome.REORDERED, "~"));

    private String describeStep(TrajectoryStepReport step) {
        return step.toolName() != null ? step.method() + " [" + step.toolName() + "]" : step.method();
    }

    private String annotate(TrajectoryStepReport step, boolean isFirstPostDivergence) {
        if (step.phase() == Phase.POST_DIVERGENCE) {
            return isFirstPostDivergence ? "ROOT DIVERGENCE -- never served" : "POST-DIVERGENCE";
        }
        return switch (step.outcome()) {
            case TOLERATED, DRIFTED, REORDERED -> step.outcome().wireValue() + " " + String.format("%.2f", step.score()) + " " + step.tier().wireValue();
            case ADDED -> "added";
            case MISSING -> "missing";
            case REQUIRED_MISSING -> "REQUIRED, not observed";
            case PROHIBITED_PRESENT -> "PROHIBITED";
            case OPTIONAL_ABSENT -> "optional, not observed";
            default -> "";
        };
    }

    /** Human-readable rendering of a canonical report. */
    public String renderHumanReport(TrajectoryReport report, String title) {
        StringBuilder sb = new StringBuilder();
        if (title != null) {
            sb.append("deja: trajectory gate -- ").append(title).append("\n\n");
        }

        List<TrajectoryStepReport> steps = report.steps();
        boolean seenRootDivergence = false;
        for (int i = 0; i < steps.size(); i++) {
            TrajectoryStepReport step = steps.get(i);
            String symbol = OUTCOME_SYMBOL.getOrDefault(step.outcome(), "?");
            boolean isFirstPostDivergence = step.phase() == Phase.POST_DIVERGENCE && !seenRootDivergence;
            if (isFirstPostDivergence) {
                seenRootDivergence = true;
            }
            String note = annotate(step, isFirstPostDivergence);

            sb.append(i + 1).append(". ").append(symbol).append(' ').append(describeStep(step));
            if (!note.isEmpty()) {
                sb.append("   ").append(note);
            }
            sb.append('\n');
        }

        sb.append("\nResult:\n");
        sb.append("  exact: ").append(report.summary().exact()).append('\n');
        sb.append("  tolerated: ").append(report.summary().tolerated()).append('\n');
        if (report.summary().drifted() > 0) {
            sb.append("  drifted: ").append(report.summary().drifted()).append('\n');
        }
        if (report.summary().reordered() > 0) {
            sb.append("  reordered: ").append(report.summary().reordered()).append('\n');
        }
        if (report.summary().added() > 0) {
            sb.append("  added: ").append(report.summary().added()).append('\n');
        }
        if (report.summary().missing() > 0) {
            sb.append("  missing: ").append(report.summary().missing()).append('\n');
        }
        if (report.summary().requiredMissing() > 0) {
            sb.append("  required missing: ").append(report.summary().requiredMissing()).append('\n');
        }
        if (report.summary().prohibitedPresent() > 0) {
            sb.append("  prohibited present: ").append(report.summary().prohibitedPresent()).append('\n');
        }
        if (report.session() != null && report.session().replayMisses() > 0) {
            long postDivergenceCount = steps.stream().filter(s -> s.phase() == Phase.POST_DIVERGENCE).count() - 1;
            sb.append("  root divergences: 1\n");
            sb.append("  post-divergence observations: ").append(Math.max(postDivergenceCount, 0)).append('\n');
        }

        sb.append('\n');
        sb.append(report.summary().passed() ? "PASS (mode=" + report.mode().wireValue() + ")"
                : "FAIL -- behavior diverged (mode=" + report.mode().wireValue() + ")");

        return sb.toString();
    }
}
