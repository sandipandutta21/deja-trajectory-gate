import { ChildProcess, spawn } from "node:child_process";

/** Bounded grace period between a timeout's SIGTERM and the follow-up SIGKILL. Not
 *  user-configurable in v1 -- only the overall `--timeout` is. */
const SIGTERM_GRACE_MS = 5000;

export interface AgentRunResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
}

export interface AgentRun {
    child: ChildProcess;
    done: Promise<AgentRunResult>;
}

/**
 * Spawns the agent under test with `DEJA_MCP_URL` in its environment, inheriting this
 * process's stdio so the user sees the agent's own output live -- deja never parses it, the
 * agent talks MCP over HTTP to the replay server, not over this process's stdio.
 *
 * Bounds the whole run with `timeoutMs` when given (graceful SIGTERM, then SIGKILL after a
 * fixed grace period), and forwards SIGINT/SIGTERM received by this process straight through to
 * the child so `Ctrl+C` on `deja gate` doesn't orphan the agent process.
 */
export function runAgent(command: string[], mcpUrl: string, timeoutMs?: number): AgentRun {
    const child = spawn(command[0], command.slice(1), {
        stdio: "inherit",
        env: { ...process.env, DEJA_MCP_URL: mcpUrl },
    });

    const done = new Promise<AgentRunResult>((resolveRun) => {
        let timedOut = false;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const forwardSignal = (signal: NodeJS.Signals): void => {
            child.kill(signal);
        };
        process.on("SIGINT", forwardSignal);
        process.on("SIGTERM", forwardSignal);

        if (timeoutMs !== undefined) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                killTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_GRACE_MS);
            }, timeoutMs);
        }

        child.on("exit", (exitCode, signal) => {
            clearTimeout(timeoutTimer);
            clearTimeout(killTimer);
            process.off("SIGINT", forwardSignal);
            process.off("SIGTERM", forwardSignal);
            resolveRun({ exitCode, signal, timedOut });
        });
    });

    return { child, done };
}
