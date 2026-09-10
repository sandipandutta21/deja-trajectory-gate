# Trajectory Gate Benchmark — Results

Generated corpus of 1520 labeled golden/actual trajectory pairs, spanning 10 realistic multi-step agent flows across six tool families (filesystem, database, GitHub, financial, generic API, protocol-level), each run through transforms -- identical, tolerated argument noise, genuine reorders, dropped/added/duplicated calls, dangerous argument drift, tool swaps, and policy required/prohibited checks -- and scored against `compareTrajectories` in every mode that transform is actually meant to exercise. Regenerate with `npm run benchmark:trajectory` from `ts/`. See `benchmarks/trajectory-corpus.mjs` for every case and its rationale.

Cases by mode: `policy`: 200, `strict`: 910, `subset`: 100, `superset`: 200, `unordered`: 110.

## Summary

| Metric | Value |
|---|---:|
| Precision (of trajectories the gate passed, how many were genuinely fine) | 100.0% |
| Recall (of genuinely fine trajectories, how many the gate correctly passed) | 98.9% |
| False-positive rate (of genuine divergences, how many the gate silently passed) | 0.0% |
| Avg. latency per `compareTrajectories` call | 39.06 µs |

**False-positive rate is the number that matters most here**: it's the fraction of genuine behavioral divergences (a dropped call, a swapped tool, a 10x change to a money transfer, a prohibited call) that the gate let through as "passed" anyway -- a regression that ships to CI with no red flag. A false alarm (the other kind of mistake, counted in recall) costs a few minutes rerunning a gate on a benign variation; a false positive here costs a silent regression.

## By category and mode

| Category [mode] | Cases | Correct | Expected verdict |
|---|---:|---:|---|
| added_step[strict] | 100 | 100/100 | FAIL |
| added_step[superset] | 100 | 100/100 | PASS |
| drifted_numeric[strict] | 40 | 40/40 | FAIL |
| drifted_tool_swap[strict] | 100 | 100/100 | FAIL |
| dropped_step[strict] | 100 | 100/100 | FAIL |
| dropped_step[subset] | 100 | 100/100 | PASS |
| duplicate_call[strict] | 100 | 100/100 | FAIL |
| duplicate_call[superset] | 100 | 100/100 | PASS |
| full_permutation[strict] | 10 | 10/10 | FAIL |
| full_permutation[unordered] | 10 | 10/10 | PASS |
| identical[strict] | 100 | 100/100 | PASS |
| policy_prohibited_violated[policy] | 100 | 100/100 | FAIL |
| policy_required_met[policy] | 100 | 100/100 | PASS |
| reordered_swap[strict] | 100 | 100/100 | FAIL |
| reordered_swap[unordered] | 100 | 100/100 | PASS |
| tolerated_key_order[strict] | 80 | 80/80 | PASS |
| tolerated_optional_param_added[strict] | 100 | 90/100 | PASS |
| tolerated_whitespace_prose[strict] | 80 | 80/80 | PASS |

## Known limitations

All 10 disagreements below are the same known case, not 10 different bugs: adding one optional argument to a call whose golden params were *empty* (`tools/list`, no arguments) is a 100% relative change in key count, the largest the structural-similarity tier ever considers -- so it can score just under the 0.75 threshold and get diagnosed as `drifted` instead of `tolerated`, failing strict mode for a call that was actually fine. This matches benchmarks/RESULTS.md's own finding that `optional_param_added` isn't 100% even at the single-request matching layer (190/194) -- Trajectory Gate inherits that layer's limitations, it doesn't add new ones on top for this category.

## Disagreements (gate verdict vs. ground truth)

| Case | Category | Mode | Expected | Got |
|---|---|---|---|---|
| `list-read-0__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-1__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-2__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-3__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-4__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-5__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-6__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-7__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-8__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |
| `list-read-9__tolerated_optional_param_added[strict]` | tolerated_optional_param_added | strict | PASS | FAIL |

## Scale (one-off, hand-run only -- not part of the default benchmark or CI)

A single golden/actual pair per size, every step sharing one `(method, toolName)` group under `unordered` mode -- the real O(n³) Hungarian path, not an artificially-fast multi-group case. Run with `node benchmarks/trajectory-run.mjs --scale`; not run by default because 1,000 steps in one group is deliberately slow.

| Steps per side | `compareTrajectories` latency |
|---:|---:|
| 100 | 293.1 ms |
| 500 | 7648.7 ms |
| 1000 | 30424.7 ms |


