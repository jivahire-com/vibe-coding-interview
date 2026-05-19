#pragma once

#include "sensor_reading.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace wafer {

// =============================================================================
// Task 5 — design and implement this.
//
// src/excursion_reporter.cpp ships as a no-op stub so the project links.
// Replace its contents with a real implementation. Layout, queue design,
// worker threads, and backpressure policy are all yours.
//
// What it must do
// ---------------
// ChamberAggregator hands every detected SPC excursion to ExcursionReporter::report().
// The reporter buffers excursions and flushes them in batches to a downstream
// SinkFn. The sink may be slow, may block, and may throw — handle that.
//
// Behaviour requirements
// ----------------------
// 1. report() is called from the aggregator's hot path (multi-threaded). It must
//    return quickly. Do not perform the sink call inline.
// 2. Excursions are flushed to `sink` in batches. The batch size is bounded by
//    `max_batch_size`. A flush also occurs at least every `max_flush_interval`.
// 3. Backpressure: if the sink cannot keep up, you choose the policy. Document
//    your choice in code comments. Acceptable policies include block-on-full,
//    drop-oldest, drop-newest, or coalesce. Justify your trade-off.
// 4. shutdown() must drain pending excursions to the sink and join any worker
//    thread(s) cleanly. After shutdown(), report() is a no-op.
// 5. The destructor must call shutdown() if it has not been called.
//
// What gets graded
// ----------------
// - Correctness against the [reporter] tests (see tests/public_tests.cpp).
// - Concurrency safety under the [reporter_concurrent] hidden test.
// - Architecture: choice of queue, threading model, backpressure policy, and
//   the clarity of your trade-off explanation.
// - Resource discipline: no leaks, no hangs on shutdown, no lost excursions
//   under the chosen policy.
//
// What is NOT graded
// ------------------
// - Persistence to disk / network. The sink is a function; assume it handles
//   the downstream concern.
// - Schema evolution of Excursion. Use it as defined in sensor_reading.h.
// =============================================================================

class ExcursionReporter {
public:
    using SinkFn = std::function<void(std::vector<Excursion>)>;

    struct Config {
        std::size_t                max_batch_size;
        std::chrono::milliseconds  max_flush_interval;
        std::size_t                max_queue_depth;  // for backpressure

        Config() noexcept
            : max_batch_size(64),
              max_flush_interval(std::chrono::milliseconds(100)),
              max_queue_depth(4096) {}
    };

    explicit ExcursionReporter(SinkFn sink, Config cfg = {});
    ~ExcursionReporter();

    ExcursionReporter(const ExcursionReporter&)            = delete;
    ExcursionReporter& operator=(const ExcursionReporter&) = delete;

    // Hot path. Must return quickly. Safe to call from multiple threads.
    void report(const Excursion& e);

    // Drain any pending excursions and stop the worker. Idempotent.
    void shutdown();

    // For tests/diagnostics. Total excursions accepted by report() (whether or
    // not they were eventually flushed, depending on backpressure policy).
    [[nodiscard]] std::uint64_t accepted_count() const noexcept;

    // For tests/diagnostics. Total excursions actually delivered to the sink.
    [[nodiscard]] std::uint64_t delivered_count() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace wafer
