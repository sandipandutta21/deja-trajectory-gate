// Labeled benchmark corpus for Trajectory Gate's own comparison engine -- not the matching tier
// ladder underneath it (that's benchmarks/corpus.mjs, and it's a genuinely different question:
// "is this one request the same as that recorded one" vs. "did this whole multi-step run stay
// equivalent to the approved golden"). Generated the same way: a handful of realistic multi-step
// agent flows across several tool families, run through transforms that each produce an actual
// trajectory plus an explicit, human-authored ground-truth verdict for a specific comparison mode.
//
// See trajectory-run.mjs for how these are scored, and ../../README.md#benchmark for the results.

// ---------------------------------------------------------------------------
// Value pools and per-call builders -- deliberately similar in spirit to benchmarks/corpus.mjs's,
// but kept separate: that corpus is frozen evidence for the matching tier ladder, this one is
// its own thing and shouldn't shift if that one regenerates.
// ---------------------------------------------------------------------------

const PATHS = [
    "/home/user/projects/deja/data/config.txt", "/var/log/app/output.log", "/etc/nginx/nginx.conf",
    "/home/alice/reports/q3-summary.pdf", "/data/exports/users.csv", "/srv/www/static/index.html",
    "/tmp/build/output.bin", "/opt/app/config/settings.yaml",
];
const QUERIES = [
    "quarterly revenue report", "unresolved customer complaints", "recent deployment failures",
    "top contributors this quarter", "average response time last week", "most active repositories",
    "latest security advisories", "open source license comparison",
];
const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi"];
const IDENTIFIERS = ["acc-000123456789", "user-501", "order-77821", "req-4471193", "sess-802234", "tok-556621", "case-91820", "batch-40021"];
const REPOS = ["org/repo", "acme/widgets", "octo/cli", "data/pipeline", "team/service-a", "core/engine", "infra/deploy", "ops/scripts"];
const TABLES = ["users", "orders", "events", "sessions", "payments", "invoices", "refunds", "audit_log"];

function pick(pool, i, salt = 0) {
    return pool[(i * 7 + salt) % pool.length];
}

function fsRead(i) {
    return { tool: "read_text_file", method: "tools/call", family: "filesystem", args: { path: pick(PATHS, i) }, roles: { path: "path" } };
}
function fsWrite(i) {
    return { tool: "write_file", method: "tools/call", family: "filesystem", args: { path: pick(PATHS, i, 3), content: pick(QUERIES, i, 5) }, roles: { path: "path", content: "prose" } };
}
function fsList(i) {
    const p = pick(PATHS, i, 2);
    return { tool: "list_files", method: "tools/call", family: "filesystem", args: { dir: p.slice(0, p.lastIndexOf("/")) || "/" }, roles: { dir: "path" } };
}
function dbQuery(i) {
    return { tool: "query_rows", method: "tools/call", family: "database", args: { table: pick(TABLES, i), filter: pick(QUERIES, i, 4) }, roles: { table: "identifier", filter: "prose" } };
}
function dbUpdateRow(i) {
    return { tool: "update_row", method: "tools/call", family: "database", args: { table: pick(TABLES, i, 1), id: pick(IDENTIFIERS, i), note: pick(QUERIES, i, 6) }, roles: { table: "identifier", id: "identifier", note: "prose" } };
}
function dbDeleteRows(i) {
    return { tool: "delete_rows", method: "tools/call", family: "database", args: { table: pick(TABLES, i, 2), from: 1 + (i % 5), to: 10 + (i % 5) }, roles: { table: "identifier", from: "numeric-dangerous", to: "numeric-dangerous" } };
}
function ghGetIssue(i) {
    return { tool: "get_issue", method: "tools/call", family: "github", args: { repo: pick(REPOS, i), issue: 1 + (i % 500) }, roles: { repo: "identifier", issue: "numeric-dangerous" } };
}
function ghCloseIssue(i) {
    return { tool: "close_issue", method: "tools/call", family: "github", args: { repo: pick(REPOS, i, 2), issue: 1 + (i % 300) }, roles: { repo: "identifier", issue: "numeric-dangerous" } };
}
function ghSearchCode(i) {
    return { tool: "search_code", method: "tools/call", family: "github", args: { repo: pick(REPOS, i, 4), query: pick(QUERIES, i, 7) }, roles: { repo: "identifier", query: "prose" } };
}
function ghGetCommit(i) {
    return { tool: "get_commit", method: "tools/call", family: "github", args: { repo: pick(REPOS, i, 1), sha: pick(IDENTIFIERS, i, 3) }, roles: { repo: "identifier", sha: "identifier" } };
}
function finTransfer(i) {
    return { tool: "transfer_money", method: "tools/call", family: "financial", args: { amount: 10 * (1 + (i % 50)), recipient: pick(NAMES, i) }, roles: { amount: "numeric-dangerous", recipient: "prose" } };
}
function finRefund(i) {
    return { tool: "refund_money", method: "tools/call", family: "financial", args: { amount: 5 * (1 + (i % 80)), recipient: pick(NAMES, i, 4) }, roles: { amount: "numeric-dangerous", recipient: "prose" } };
}
function finSetPermission(i) {
    return { tool: "set_permission", method: "tools/call", family: "financial", args: { user: pick(NAMES, i, 2), level: 1 + (i % 9) }, roles: { user: "prose", level: "numeric-dangerous" } };
}
function apiSearch(i) {
    return { tool: "search", method: "tools/call", family: "generic_api", args: { query: pick(QUERIES, i) }, roles: { query: "prose" } };
}
function apiSummarize(i) {
    return { tool: "summarize", method: "tools/call", family: "generic_api", args: { text: pick(QUERIES, i, 11) }, roles: { text: "prose" } };
}
function apiWeather(i) {
    return { tool: "get_weather", method: "tools/call", family: "generic_api", args: { city: pick(NAMES, i, 9) }, roles: { city: "prose" } };
}
function apiEcho(i) {
    return { tool: "echo", method: "tools/call", family: "generic_api", args: { message: pick(QUERIES, i, 9) }, roles: { message: "prose" } };
}
function protoToolsList(i) {
    return { tool: undefined, method: "tools/list", family: "protocol", args: {}, roles: {} };
}

// A step from outside every flow template below, for "the agent did one extra thing" cases --
// cycled deterministically so `added_step`/`policy_prohibited_violated` never collide with a
// tool the base flow already calls.
const EXTRA_BUILDERS = [apiWeather, apiEcho];
function extraStep(i) {
    return EXTRA_BUILDERS[i % EXTRA_BUILDERS.length](i + 50);
}

const TOOL_SIBLINGS = {
    read_text_file: "write_file", write_file: "read_text_file", list_files: "read_text_file",
    query_rows: "update_row", update_row: "delete_rows", delete_rows: "query_rows",
    get_issue: "close_issue", close_issue: "get_issue", search_code: "get_commit", get_commit: "get_issue",
    transfer_money: "refund_money", refund_money: "transfer_money", set_permission: "transfer_money",
    search: "summarize", summarize: "search",
};

const OPTIONAL_PARAM_BY_FAMILY = {
    filesystem: ["recursive", true],
    database: ["limit", 50],
    github: ["per_page", 20],
    financial: ["note", "thanks"],
    generic_api: ["limit", 10],
    protocol: ["verbose", true],
};

function findRoleKey(it, role) {
    for (const [key, r] of Object.entries(it.roles)) if (r === role) return key;
    return null;
}

// ---------------------------------------------------------------------------
// Flow templates -- each a short, realistic sequence of tool calls an agent might actually make.
// ---------------------------------------------------------------------------

const FLOWS = [
    (i) => [fsRead(i), fsWrite(i)],
    (i) => [dbQuery(i), dbUpdateRow(i)],
    (i) => [ghGetIssue(i), ghCloseIssue(i)],
    (i) => [ghSearchCode(i), ghGetCommit(i)],
    (i) => [finTransfer(i), finSetPermission(i)],
    (i) => [fsList(i), fsRead(i), fsWrite(i)],
    (i) => [apiSearch(i), apiSummarize(i)],
    (i) => [dbQuery(i), dbDeleteRows(i)],
    (i) => [finTransfer(i), finRefund(i)],
    (i) => [protoToolsList(i), fsRead(i)],
];
const FLOW_NAMES = [
    "read-write", "query-update", "issue-close", "search-commit", "transfer-permission",
    "list-read-write", "search-summarize", "query-delete", "transfer-refund", "list-read",
];
const INSTANCES_PER_FLOW = 10;

// ---------------------------------------------------------------------------
// Transforms -- each takes a base trajectory (array of call descriptors) and an index (for
// picking a deterministic "extra step"), and returns zero or more case descriptors: a category,
// the comparison mode it's evaluated under, the expected pass/fail verdict, why, the actual
// trajectory, and (for policy mode) the policy.
// ---------------------------------------------------------------------------

function cIdentical(base) {
    return [{ category: "identical", mode: "strict", shouldFail: false,
        rationale: "A byte-identical trajectory is the floor every mode must accept.", actual: base }];
}

function cToleratedKeyOrder(base) {
    const idx = base.findIndex((it) => Object.keys(it.args).length >= 2);
    if (idx === -1) return [];
    const keys = Object.keys(base[idx].args);
    const reversed = {};
    for (const k of [...keys].reverse()) reversed[k] = base[idx].args[k];
    const actual = base.map((s, i) => (i === idx ? { ...s, args: reversed } : s));
    return [{ category: "tolerated_key_order", mode: "strict", shouldFail: false,
        rationale: "Argument key order on one step must never gate an otherwise-identical trajectory.", actual }];
}

function cToleratedWhitespaceProse(base) {
    const idx = base.findIndex((it) => findRoleKey(it, "prose"));
    if (idx === -1) return [];
    const key = findRoleKey(base[idx], "prose");
    const actual = base.map((s, i) => (i === idx ? { ...s, args: { ...s.args, [key]: ` ${s.args[key]} ` } } : s));
    return [{ category: "tolerated_whitespace_prose", mode: "strict", shouldFail: false,
        rationale: "Incidental whitespace in one step's free text is not a behavior change.", actual }];
}

function cToleratedOptionalParamAdded(base) {
    const idx = base.findIndex((it) => OPTIONAL_PARAM_BY_FAMILY[it.family] && !(OPTIONAL_PARAM_BY_FAMILY[it.family][0] in it.args));
    if (idx === -1) return [];
    const [key, value] = OPTIONAL_PARAM_BY_FAMILY[base[idx].family];
    const actual = base.map((s, i) => (i === idx ? { ...s, args: { ...s.args, [key]: value } } : s));
    return [{ category: "tolerated_optional_param_added", mode: "strict", shouldFail: false,
        rationale: "An additive, non-identifying argument on one step shouldn't gate the trajectory.", actual }];
}

function cReorderedSwap(base) {
    if (base.length < 2) return [];
    const actual = [...base];
    [actual[0], actual[1]] = [actual[1], actual[0]];
    return [
        { category: "reordered_swap", mode: "strict", shouldFail: true,
            rationale: "Two calls swapping position is still a divergence strict mode must fail (diagnosed as `reordered`, not a disconnected added/missing pair).", actual },
        { category: "reordered_swap", mode: "unordered", shouldFail: false,
            rationale: "Same set of calls, order doesn't matter under unordered mode.", actual },
    ];
}

function cFullPermutation(base) {
    if (base.length < 3) return [];
    const actual = [...base].reverse();
    return [
        { category: "full_permutation", mode: "strict", shouldFail: true,
            rationale: "A fully reordered trajectory is still a divergence under strict mode.", actual },
        { category: "full_permutation", mode: "unordered", shouldFail: false,
            rationale: "Same multiset of calls in a different order is exactly what unordered mode is for.", actual },
    ];
}

function cDroppedStep(base) {
    if (base.length < 2) return [];
    const actual = base.slice(1);
    return [
        { category: "dropped_step", mode: "strict", shouldFail: true,
            rationale: "A missing call is a real behavior change under strict mode.", actual },
        { category: "dropped_step", mode: "subset", shouldFail: false,
            rationale: "Subset mode exists precisely to tolerate a golden call the agent chose to skip.", actual },
    ];
}

function cAddedStep(base, i) {
    const actual = [...base, extraStep(i)];
    return [
        { category: "added_step", mode: "strict", shouldFail: true,
            rationale: "An extra call beyond the golden trajectory is a real behavior change under strict mode.", actual },
        { category: "added_step", mode: "superset", shouldFail: false,
            rationale: "Superset mode exists precisely to tolerate an extra call beyond the golden trajectory.", actual },
    ];
}

function cDuplicateCall(base) {
    const actual = [...base, base[base.length - 1]];
    return [
        { category: "duplicate_call", mode: "strict", shouldFail: true,
            rationale: "Calling the same tool an extra time beyond what the golden recorded is a real divergence strict mode must catch.", actual },
        { category: "duplicate_call", mode: "superset", shouldFail: false,
            rationale: "An extra, harmless repeat of an already-approved call is exactly what superset mode tolerates.", actual },
    ];
}

function cDriftedNumeric(base) {
    const idx = base.findIndex((it) => findRoleKey(it, "numeric-dangerous"));
    if (idx === -1) return [];
    const key = findRoleKey(base[idx], "numeric-dangerous");
    const actual = base.map((s, i) => (i === idx ? { ...s, args: { ...s.args, [key]: s.args[key] * 10 + 1 } } : s));
    return [{ category: "drifted_numeric", mode: "strict", shouldFail: true,
        rationale: "A large relative change to a safety-critical quantity must never be silently accepted as equivalent.", actual }];
}

function cDriftedToolSwap(base) {
    const idx = base.findIndex((it) => it.tool && TOOL_SIBLINGS[it.tool]);
    if (idx === -1) return [];
    const sibling = TOOL_SIBLINGS[base[idx].tool];
    const actual = base.map((s, i) => (i === idx ? { ...s, tool: sibling } : s));
    return [{ category: "drifted_tool_swap", mode: "strict", shouldFail: true,
        rationale: "A different tool at the same position is never the same call, however similar the arguments.", actual }];
}

function cPolicyRequiredMet(base) {
    const toolStep = base.find((it) => it.tool);
    if (!toolStep) return [];
    const policy = { policyVersion: 1, required: [{ method: "tools/call", toolName: toolStep.tool }] };
    return [{ category: "policy_required_met", mode: "policy", shouldFail: false,
        rationale: "The required call is present; policy mode should accept the trajectory.", actual: base, policy }];
}

function cPolicyProhibitedViolated(base, i) {
    const toolStep = base.find((it) => it.tool);
    if (!toolStep) return [];
    const extra = extraStep(i);
    const policy = {
        policyVersion: 1,
        required: [{ method: "tools/call", toolName: toolStep.tool }],
        prohibited: [{ method: "tools/call", toolName: extra.tool }],
    };
    const actual = [...base, extra];
    return [{ category: "policy_prohibited_violated", mode: "policy", shouldFail: true,
        rationale: "A prohibited call appearing anywhere in the trajectory must fail policy mode, regardless of what else is satisfied.", actual, policy }];
}

const TRANSFORMS = [
    (base) => cIdentical(base),
    (base) => cToleratedKeyOrder(base),
    (base) => cToleratedWhitespaceProse(base),
    (base) => cToleratedOptionalParamAdded(base),
    (base) => cReorderedSwap(base),
    (base) => cFullPermutation(base),
    (base) => cDroppedStep(base),
    (base, i) => cAddedStep(base, i),
    (base) => cDuplicateCall(base),
    (base) => cDriftedNumeric(base),
    (base) => cDriftedToolSwap(base),
    (base) => cPolicyRequiredMet(base),
    (base, i) => cPolicyProhibitedViolated(base, i),
];

// ---------------------------------------------------------------------------
// Wire-shape helper -- matches what extractTrajectory actually produces (see
// src/trajectory/extract.ts): `params` is the full post-normalize params object
// (`{ name, arguments }` for tools/call, the bare params object otherwise).
// ---------------------------------------------------------------------------

function toStep(it, index) {
    const params = it.tool ? { name: it.tool, arguments: it.args } : it.args ?? {};
    return { index, method: it.method, toolName: it.tool, params, frameIndex: index, tMs: index * 10 };
}

function buildCorpus() {
    const cases = [];
    FLOWS.forEach((flow, flowIdx) => {
        for (let i = 0; i < INSTANCES_PER_FLOW; i++) {
            const base = flow(i);
            for (const transform of TRANSFORMS) {
                const results = transform(base, i) ?? [];
                for (const r of results) {
                    cases.push({
                        id: `${FLOW_NAMES[flowIdx]}-${i}__${r.category}[${r.mode}]`,
                        category: r.category,
                        mode: r.mode,
                        shouldFail: r.shouldFail,
                        rationale: r.rationale,
                        golden: base.map((it, si) => toStep(it, si)),
                        actual: r.actual.map((it, si) => toStep(it, si)),
                        policy: r.policy,
                    });
                }
            }
        }
    });
    return cases;
}

export const corpus = buildCorpus();
