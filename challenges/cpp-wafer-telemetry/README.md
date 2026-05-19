# Streaming Metrics Aggregator (C++17)

You have **~60 minutes** (90-minute hard cap) to fix concurrency and numerical
bugs in a streaming stats aggregator, wire SPC excursion detection through, and
design a batched async reporter from scratch.

The starter builds with C++17. You are welcome to bump `CMAKE_CXX_STANDARD` to
20 or 23 (e.g. `std::jthread`, `std::format`) — pick the standard you are most
fluent in.

---

## What this code does

Imagine a service that collects numeric measurements from many sources at the
same time. Each source streams thousands of values per second while it is
active. When a source finishes a unit of work, the service must publish a
summary of what just happened.

For each (source, sensor) pair the service keeps a running summary: count,
mean, standard deviation, min, max. Any value that lies more than 3 standard
deviations from the mean is an **anomaly** and must be flagged. When a unit of
work finishes, the service emits one final record for it and forgets its
in-memory state.

Many sources feed the service at the same time, on different threads.

> The code uses words from a semiconductor fab as flavour — `chamber`,
> `wafer`, `excursion`. Treat them as generic names: **chamber = a
> source/worker**, **wafer = one unit of work with a start and end** (think:
> one HTTP session, one game match, one batch job), **excursion = an anomalous
> reading**. No domain knowledge is required or tested.

---

## What you must deliver

All work is in `src/chamber_aggregator.{h,cpp}` and a new
`src/excursion_reporter.cpp` (Task 5). Read-only reference files:
`src/sensor_reading.h`, `src/spc_limits.{h,cpp}`, `src/main.cpp`.

### 1. Make `ingest()` thread-safe

Multiple threads call `ingest()` concurrently with no lock — memory gets
corrupted. Add synchronisation. Keep `ingest()` fast (~1000 calls/sec/source).
Be ready to explain your choice of primitive and lock granularity.

### 2. Fix the standard-deviation math

Variance is computed as `(sum_of_squares - sum^2/n) / (n-1)`. This gives NaN or
zero for series with a large mean and small variance (e.g. readings around
760 ± 0.001) — classic floating-point cancellation. Replace it with a
numerically stable single-pass algorithm. You cannot store raw samples. The
test `pressure_stability_around_760_torr` shows the bug.

### 3. Wire in anomaly detection

`SpcLimits::is_excursion()` works, but `ingest()` never calls it. After
updating stats in `ingest()`: call `is_excursion()`, increment the per-wafer
excursion counter if true, and forward to the `ExcursionReporter` if one was
provided.

### 4. Implement `on_wafer_complete()`

When a unit of work ends, build a `WaferRecord` with per-sensor stats and the
anomaly count, append it to the completed list (consumers call
`drain_completed()`), free the in-memory state, and mark the unit as done —
any reading that arrives after this for the same unit must be silently dropped.

### 5. Build `ExcursionReporter`

`src/excursion_reporter.h` has the header and the full contract.
`src/excursion_reporter.cpp` ships as a no-op stub so the project links —
replace its contents with a real implementation. Queue type, worker threads,
mutex/condvar choice, and backpressure policy are all your design.

The reporter buffers anomalies and flushes them in batches to a callback (the
"sink"). The sink can be slow. Requirements:

- `report()` must not block (it is on the hot path).
- Nothing accepted by `report()` is lost on shutdown.
- Decide what happens when the sink falls behind: drop, block, or coalesce —
  your call, but write down why in code comments or a short `DESIGN.md`.

---

## How to build and run tests

```bash
# First time only — fetches Catch2 (~10s, cached after)
cmake -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build -j

# Run all tests
./build/tests

# Run a specific tag group
./build/tests "[thread]"
./build/tests "[stats]"
./build/tests "[lifecycle]"
./build/tests "[reporter]"
```

See `SETUP.md` for toolchain and TSan instructions.

The public test file (`tests/public_tests.cpp`) is intentionally mostly red on
the starter — failing tests are signposting the bugs. When you submit,
additional **hidden tests** run from the same `tests/` directory.

---

## Using AI (encouraged — we evaluate *how* you use it)

Open the **Vibe AI** panel in the sidebar. Your budget is shown at the top.

We measure:

- **Prompt quality**: are your questions targeted, or do you paste entire files
  and ask "fix this"?
- **Critical evaluation**: do you test AI-generated code before accepting it?
- **Independence**: do you understand the solution you submit?

Pasting AI output is fine. Pasting it without testing is not.

---

## Submitting

Click **Submit** in the Vibe AI sidebar, or run `Vibe: Submit` from the command
palette (`Ctrl+Shift+P`). Auto-submit fires at the time limit if you forget.
Make sure your latest changes are committed (`git status` clean) before you
submit. The extension also auto-commits every 3 minutes.

---

## Scoring dimensions (the rubric is hidden, but the dimensions are not)

| Dimension | Weight | What we look at |
|---|---|---|
| Test pass rate | 25% | Which test groups pass (automated) |
| Trap detection | 15% | Did the planted bugs get fixed (automated, tag-based) |
| Code quality | 25% | Correctness, thread safety under TSan, numerical stability, C++ idioms |
| AI orchestration | 20% | How you used the AI (prompt history in your git log) |
| Architectural reasoning | 15% | Reporter design, lock granularity, shutdown discipline |
