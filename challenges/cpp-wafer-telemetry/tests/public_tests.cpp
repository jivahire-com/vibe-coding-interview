// Public Catch2 test suite. The grader runs an additional hidden suite that
// covers concurrency stress, more edge cases, and ExcursionReporter semantics.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "chamber_aggregator.h"
#include "excursion_reporter.h"
#include "sensor_reading.h"
#include "spc_limits.h"

#include <atomic>
#include <chrono>
#include <random>
#include <thread>
#include <vector>

using namespace wafer;
using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;

namespace {
SensorReading make_reading(const std::string& chamber,
                           const std::string& wafer,
                           const std::string& sensor,
                           double value) {
    return SensorReading{chamber, wafer, sensor, value,
                         std::chrono::steady_clock::now()};
}
}  // namespace

// -----------------------------------------------------------------------------
// [basic] ingest + stats
// -----------------------------------------------------------------------------
TEST_CASE("basic_ingest_counts_samples", "[basic]") {
    ChamberAggregator agg;
    for (int i = 0; i < 10; ++i) {
        agg.ingest(make_reading("ETCH-A1", "W1", "pressure_torr", 100.0 + i));
    }
    auto stats = agg.compute_running_stats("ETCH-A1", "W1", "pressure_torr");
    REQUIRE(stats.has_value());
    CHECK(stats->count == 10);
    CHECK_THAT(stats->mean, WithinAbs(104.5, 1e-9));
    CHECK_THAT(stats->min,  WithinAbs(100.0, 1e-9));
    CHECK_THAT(stats->max,  WithinAbs(109.0, 1e-9));
}

// -----------------------------------------------------------------------------
// [stats] numerical stability — large mean, small variance
// THIS IS EXPECTED TO FAIL on the starter implementation. Fixing it is Task 2.
// -----------------------------------------------------------------------------
TEST_CASE("pressure_stability_around_760_torr", "[stats]") {
    ChamberAggregator agg;
    std::mt19937 rng(42);
    std::normal_distribution<double> dist(760.0, 0.001);
    for (int i = 0; i < 10'000; ++i) {
        agg.ingest(make_reading("ETCH-A1", "W1", "pressure_torr", dist(rng)));
    }
    auto stats = agg.compute_running_stats("ETCH-A1", "W1", "pressure_torr");
    REQUIRE(stats.has_value());
    // True stddev is ~0.001. The naive sum-of-squares method produces NaN or
    // a wildly wrong value here.
    CHECK_THAT(stats->stddev, WithinRel(0.001, 0.10));
}

// -----------------------------------------------------------------------------
// [thread] concurrent ingest is race-free.
// THIS IS EXPECTED TO FAIL (intermittently) on the starter. Fixing it is Task 1.
// -----------------------------------------------------------------------------
TEST_CASE("concurrent_ingest_no_lost_samples", "[thread]") {
    ChamberAggregator agg;
    constexpr int kThreads = 8;
    constexpr int kPerThread = 5'000;

    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&agg, t]() {
            for (int i = 0; i < kPerThread; ++i) {
                agg.ingest(make_reading("ETCH-A1", "W1", "pressure_torr",
                                        100.0 + (t * 1000 + i) * 1e-6));
            }
        });
    }
    for (auto& th : threads) th.join();

    auto stats = agg.compute_running_stats("ETCH-A1", "W1", "pressure_torr");
    REQUIRE(stats.has_value());
    CHECK(stats->count == kThreads * kPerThread);
}

// -----------------------------------------------------------------------------
// [lifecycle] on_wafer_complete enqueues a record and frees state.
// THIS IS EXPECTED TO FAIL on the starter. Fixing it is Task 4.
// -----------------------------------------------------------------------------
TEST_CASE("wafer_complete_emits_record_and_frees_state", "[lifecycle]") {
    ChamberAggregator agg;
    for (int i = 0; i < 5; ++i) {
        agg.ingest(make_reading("ETCH-A1", "W1", "pressure_torr", 100.0 + i));
    }
    CHECK(agg.live_wafer_count() == 1);

    agg.on_wafer_complete("ETCH-A1", "W1");
    auto records = agg.drain_completed();
    REQUIRE(records.size() == 1);
    CHECK(records[0].chamber_id == "ETCH-A1");
    CHECK(records[0].wafer_id == "W1");
    CHECK(records[0].per_sensor_stats.size() == 1);
    CHECK(agg.live_wafer_count() == 0);
}

TEST_CASE("late_readings_after_completion_are_dropped", "[lifecycle]") {
    ChamberAggregator agg;
    agg.ingest(make_reading("ETCH-A1", "W1", "pressure_torr", 100.0));
    agg.on_wafer_complete("ETCH-A1", "W1");
    (void)agg.drain_completed();

    // Late reading — must not resurrect the wafer.
    agg.ingest(make_reading("ETCH-A1", "W1", "pressure_torr", 999.0));
    CHECK(agg.live_wafer_count() == 0);
}

// -----------------------------------------------------------------------------
// [spc] SpcLimits is a complete reference — these confirm its contract.
// -----------------------------------------------------------------------------
TEST_CASE("spc_under_min_samples_returns_false", "[spc]") {
    RunningStats s{/*count=*/10, /*mean=*/100.0, /*stddev=*/1.0, 0.0, 0.0};
    auto r = make_reading("ETCH-A1", "W1", "pressure_torr", 200.0);
    CHECK_FALSE(SpcLimits::is_excursion(r, s));
}

TEST_CASE("spc_within_three_sigma_is_not_excursion", "[spc]") {
    RunningStats s{/*count=*/100, /*mean=*/100.0, /*stddev=*/1.0, 0.0, 0.0};
    auto r = make_reading("ETCH-A1", "W1", "pressure_torr", 102.5);
    CHECK_FALSE(SpcLimits::is_excursion(r, s));
}

TEST_CASE("spc_outside_three_sigma_is_excursion", "[spc]") {
    RunningStats s{/*count=*/100, /*mean=*/100.0, /*stddev=*/1.0, 0.0, 0.0};
    auto r = make_reading("ETCH-A1", "W1", "pressure_torr", 103.5);
    CHECK(SpcLimits::is_excursion(r, s));
}

// -----------------------------------------------------------------------------
// [reporter] ExcursionReporter — Task 5 (candidate writes the .cpp from scratch).
// These tests will not even link until you add src/excursion_reporter.cpp to
// CMakeLists.txt and implement the class.
// -----------------------------------------------------------------------------
TEST_CASE("reporter_flushes_on_shutdown", "[reporter]") {
    std::vector<Excursion> received;
    auto sink = [&received](std::vector<Excursion> batch) {
        for (auto& e : batch) received.push_back(std::move(e));
    };
    ExcursionReporter rep(sink);
    for (int i = 0; i < 10; ++i) {
        rep.report(Excursion{"ETCH-A1", "W1", "pressure_torr",
                             760.0 + i, 760.0, 0.001,
                             std::chrono::steady_clock::now()});
    }
    rep.shutdown();
    CHECK(received.size() == 10);
}

TEST_CASE("reporter_destructor_drains_without_explicit_shutdown", "[reporter]") {
    std::atomic<std::uint64_t> count{0};
    {
        auto sink = [&count](std::vector<Excursion> batch) {
            count += batch.size();
        };
        ExcursionReporter rep(sink);
        for (int i = 0; i < 50; ++i) {
            rep.report(Excursion{"ETCH-A1", "W1", "p", 0.0, 0.0, 0.0,
                                 std::chrono::steady_clock::now()});
        }
    }  // ~ExcursionReporter() must drain
    CHECK(count.load() == 50);
}

TEST_CASE("reporter_concurrent_report_is_safe", "[reporter]") {
    std::atomic<std::uint64_t> count{0};
    auto sink = [&count](std::vector<Excursion> batch) {
        count += batch.size();
    };
    ExcursionReporter rep(sink);

    constexpr int kThreads = 4;
    constexpr int kPerThread = 1'000;
    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&rep]() {
            for (int i = 0; i < kPerThread; ++i) {
                rep.report(Excursion{"C", "W", "s", 0.0, 0.0, 0.0,
                                     std::chrono::steady_clock::now()});
            }
        });
    }
    for (auto& th : threads) th.join();
    rep.shutdown();
    // Depending on backpressure policy, count <= kThreads * kPerThread.
    // accepted_count() should equal what was admitted; delivered_count() what
    // actually reached the sink.
    CHECK(rep.delivered_count() == count.load());
    CHECK(rep.accepted_count() <= static_cast<std::uint64_t>(kThreads * kPerThread));
}
