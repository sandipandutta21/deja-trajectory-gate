package dev.deja.cli;

import dev.deja.cli.gate.RunGate;
import dev.deja.core.cassette.CassetteContents;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.json.Json;
import dev.deja.core.trajectory.Compare;
import dev.deja.core.trajectory.CompareOptions;
import dev.deja.core.trajectory.Extract;
import dev.deja.core.trajectory.Policy;
import dev.deja.core.trajectory.Report;
import dev.deja.core.trajectory.TrajectoryMode;
import dev.deja.core.trajectory.TrajectoryPolicy;
import dev.deja.core.trajectory.TrajectoryReport;
import dev.deja.core.trajectory.TrajectoryStep;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * `deja` CLI entrypoint -- Trajectory Gate only in this module for now ({@code trajectory},
 * {@code gate}); {@code record}/{@code replay}/{@code verify}/{@code diff}/{@code redact} CLI
 * parity remains TS-only. Mirrors the relevant subset of the TypeScript implementation's
 * {@code cli.ts}.
 */
public final class Main {

    private Main() {
    }

    public static void main(String[] args) {
        if (args.length == 0) {
            printUsage();
            System.exit(2);
        }

        String command = args[0];
        List<String> rest = new ArrayList<>(List.of(args).subList(1, args.length));

        try {
            int exitCode = switch (command) {
                case "trajectory" -> runTrajectoryCommand(rest);
                case "gate" -> runGateCommand(rest);
                default -> {
                    System.err.println("Unknown command: " + command);
                    printUsage();
                    yield 2;
                }
            };
            System.exit(exitCode);
        } catch (UsageError e) {
            System.err.println("Error: " + e.getMessage());
            System.exit(2);
        } catch (IOException e) {
            System.err.println("Error: " + e.getMessage());
            System.exit(2);
        }
    }

    private static void printUsage() {
        System.err.println("Usage: deja <command> [options]");
        System.err.println("Commands: trajectory, gate");
        System.err.println("(record/replay/verify/diff/redact CLI parity is TS-only for now)");
    }

    private static final class UsageError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        UsageError(String message) {
            super(message);
        }
    }

    // --- deja trajectory ---

    private static int runTrajectoryCommand(List<String> args) throws IOException {
        Flags flags = Flags.parse(args, Set.of("mode", "policy", "derive-policy", "threshold", "include"), Set.of("json"));

        Path goldenPath = flags.positional(0, "Provide a golden cassette path (e.g., deja trajectory golden.jsonl actual.jsonl)");

        if (flags.get("derive-policy") != null) {
            CassetteContents golden = new CassetteReader(goldenPath).loadAll();
            List<TrajectoryStep> steps = Extract.extractTrajectory(golden.frames());
            TrajectoryPolicy policy = Policy.derivePolicy(steps);
            Path outputPath = Path.of(flags.get("derive-policy"));
            Files.writeString(outputPath, Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(policy) + "\n");
            System.out.println("Deja: wrote a starting policy to " + outputPath + ".");
            return 0;
        }

        Path actualPath = flags.positional(1, "Provide an actual cassette path (e.g., deja trajectory golden.jsonl actual.jsonl)");

        TrajectoryMode mode = flags.get("mode") != null ? parseMode(flags.get("mode")) : TrajectoryMode.STRICT;
        if (mode == TrajectoryMode.POLICY && flags.get("policy") == null) {
            throw new UsageError("--mode policy requires --policy <policy.json>");
        }

        CompareOptions options = CompareOptions.builder()
                .mode(mode)
                .threshold(flags.get("threshold") != null ? Double.valueOf(flags.get("threshold")) : null)
                .policy(flags.get("policy") != null ? readPolicy(Path.of(flags.get("policy"))) : null)
                .build();

        CassetteContents golden = new CassetteReader(goldenPath).loadAll();
        CassetteContents actual = new CassetteReader(actualPath).loadAll();
        Set<String> include = Set.copyOf(flags.multi("include"));

        TrajectoryReport report = Compare.compareCassetteFrames(golden.frames(), actual.frames(), options, include);

        System.out.println(flags.has("json") ? Report.toCanonicalJson(report) : Report.renderHumanReport(report, goldenPath.toString()));
        return report.summary().passed() ? 0 : 1;
    }

    // --- deja gate ---

    private static int runGateCommand(List<String> args) throws IOException {
        int dashDash = args.indexOf("--");
        List<String> before = dashDash == -1 ? args : args.subList(0, dashDash);
        List<String> agentCommand = dashDash == -1 ? List.of() : args.subList(dashDash + 1, args.size());

        Flags flags = Flags.parse(before, Set.of("port", "mode", "policy", "threshold", "timeout"), Set.of("json", "update"));

        Path goldenPath = flags.positional(0, "Provide a golden cassette path (e.g., deja gate golden.jsonl -- node agent.js)");
        if (agentCommand.isEmpty()) {
            throw new UsageError("Provide an agent command after '--' (e.g., deja gate golden.jsonl -- node agent.js)");
        }

        TrajectoryMode mode = flags.get("mode") != null ? parseMode(flags.get("mode")) : TrajectoryMode.STRICT;
        if (mode == TrajectoryMode.POLICY && flags.get("policy") == null) {
            throw new UsageError("--mode policy requires --policy <policy.json>");
        }

        RunGate.Options options = RunGate.Options.builder()
                .port(flags.get("port") != null ? Integer.valueOf(flags.get("port")) : null)
                .compareOptions(CompareOptions.builder()
                        .mode(mode)
                        .threshold(flags.get("threshold") != null ? Double.valueOf(flags.get("threshold")) : null)
                        .policy(flags.get("policy") != null ? readPolicy(Path.of(flags.get("policy"))) : null)
                        .build())
                .timeoutMs(flags.get("timeout") != null ? parseDurationMs(flags.get("timeout")) : null)
                .update(flags.has("update"))
                .build();

        RunGate.Result result = RunGate.run(goldenPath, agentCommand, options);

        if (result.report() != null) {
            System.out.println(flags.has("json") ? Report.toCanonicalJson(result.report()) : Report.renderHumanReport(result.report(), goldenPath.toString()));
            if (result.updated()) {
                System.out.println("Deja: golden cassette updated with the captured session.");
            }
        } else {
            System.err.println("Deja gate: harness failure -- " + result.reason());
        }

        return result.exitCode();
    }

    private static TrajectoryMode parseMode(String raw) {
        try {
            return TrajectoryMode.fromWireValue(raw);
        } catch (IllegalArgumentException e) {
            throw new UsageError("--mode must be one of " + java.util.Arrays.toString(TrajectoryMode.values()));
        }
    }

    private static TrajectoryPolicy readPolicy(Path path) throws IOException {
        return Json.MAPPER.readValue(path.toFile(), TrajectoryPolicy.class);
    }

    /** A bare number of milliseconds, or a number suffixed with {@code s}/{@code m} ({@code
     *  "30s"}, {@code "2m"}). */
    private static long parseDurationMs(String raw) {
        var matcher = java.util.regex.Pattern.compile("^(\\d+(?:\\.\\d+)?)(ms|s|m)?$").matcher(raw.trim());
        if (!matcher.matches()) {
            throw new UsageError("Invalid duration \"" + raw + "\" (expected e.g. \"30s\", \"2m\", or a plain millisecond count)");
        }
        double value = Double.parseDouble(matcher.group(1));
        String unit = matcher.group(2);
        double multiplier = "m".equals(unit) ? 60_000 : "s".equals(unit) ? 1_000 : 1;
        return (long) (value * multiplier);
    }

    /** Minimal hand-rolled flag parser: {@code --name value} for value flags, bare {@code
     *  --name} for boolean flags, everything else a positional. Deliberately not a generic
     *  reusable abstraction -- this CLI has exactly two commands. */
    private static final class Flags {
        private final Map<String, String> values = new LinkedHashMap<>();
        private final Map<String, List<String>> multiValues = new LinkedHashMap<>();
        private final Set<String> booleans;
        private final List<String> positionals = new ArrayList<>();

        private Flags(Set<String> booleans) {
            this.booleans = booleans;
        }

        static Flags parse(List<String> args, Set<String> valueFlagNames, Set<String> booleanFlagNames) {
            Flags flags = new Flags(booleanFlagNames);
            for (int i = 0; i < args.size(); i++) {
                String arg = args.get(i);
                if (!arg.startsWith("--")) {
                    flags.positionals.add(arg);
                    continue;
                }
                String name = arg.substring(2);
                if (booleanFlagNames.contains(name)) {
                    flags.values.put(name, "true");
                } else if (valueFlagNames.contains(name)) {
                    if (i + 1 >= args.size()) {
                        throw new UsageError("--" + name + " requires a value");
                    }
                    flags.values.put(name, args.get(++i));
                    flags.multiValues.computeIfAbsent(name, k -> new ArrayList<>()).add(flags.values.get(name));
                } else {
                    throw new UsageError("Unknown flag --" + name);
                }
            }
            return flags;
        }

        String get(String name) {
            return values.get(name);
        }

        boolean has(String name) {
            return booleans.contains(name) && values.containsKey(name);
        }

        List<String> multi(String name) {
            return multiValues.getOrDefault(name, List.of());
        }

        Path positional(int index, String errorMessage) {
            if (index >= positionals.size()) {
                throw new UsageError(errorMessage);
            }
            return Path.of(positionals.get(index));
        }
    }
}
