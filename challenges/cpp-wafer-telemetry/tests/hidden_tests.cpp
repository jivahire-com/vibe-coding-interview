// Hidden tests — not visible in the candidate's branch.
// Grader copies this file into tests/ before building. Each TEST_CASE is tagged
// with one of [thread] / [stats] / [spc] / [lifecycle] / [reporter] to match the
// rubric's per-task tags. The corresponding trap is detected when its tag group
// passes.

#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <random>
#include <thread>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "chamber_aggregator.h"
#include "excursion_reporter.h"
#include "sensor_reading.h"
#include "spc_limits.h"

using namespace wafer;
using Catch::Matchers::WithinAbs;
using Catch::Matchers::WithinRel;

namespace {
SensorReading reading_at(const std::string& chamber,
                         const std::string& wafer,
                         const std::string& sensor,
                         double value) {
    return SensorReading{chamber, wafer, sensor, value,
                         std::chrono::steady_clock::now()};
}
}  // namespace

// -----------------------------------------------------------------------------
// [thread] — Stricter concurrent-ingest test. Detects trap_race_on_ingest.
// Eight threads, multiple wafers and sensors. With a correct fix every reading
// is accounted for; without one, TSan flags races and the count is short.
// -----------------------------------------------------------------------------
TEST_CASE("thread_concurrent_ingest_no_lost_samples", "[thread]") {
    ChamberAggregator agg;
    constexpr int kThreads   = 8;
    constexpr int kPerThread = 10'000;

    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&agg, t]() {
            const std::string chamber = "ETCH-" + std::to_string(t % 2);
            for (int i = 0; i < kPerThread; ++i) {
                agg.ingest(reading_at(chamber, "W1", "pressure_torr",
                                      760.0 + (t * kPerThread + i) * 1e-9));
            }
        });
    }
    for (auto& th : threads) th.join();

    std::uint64_t total = 0;
    for (const auto& chamber : {"ETCH-0", "ETCH-1"}) {
        auto stats = agg.compute_running_stats(chamber, "W1", "pressure_torr");
        REQUIRE(stats.has_value());
        total += stats->count;
    }
    CHECK(total == static_cast<std::uint64_t>(kThreads * kPerThread));
}

TEST_CASE("thread_many_chambers_many_wafers", "[thread]") {
    ChamberAggregator agg;
    constexpr int kThreads   = 6;
    constexpr int kPerThread = 5'000;

    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&agg, t]() {
            for (int i = 0; i < kPerThread; ++i) {
                const std::string chamber = "C" + std::to_string(i % 4);
                const std::string wafer   = "W" + std::to_string(i % 3);
                agg.ingest(reading_at(chamber, wafer, "temp_c",
                                      300.0 + (t + i) * 1e-6));
            }
        });
    }
    for (auto& th : threads) th.join();
    SUCCEED("Survived concurrent ingest across multiple chambers/wafers");
}

// -----------------------------------------------------------------------------
// [stats] — Strict numerical stability. Detects trap_numerical_instability.
// True stddev is 1e-6; with a large mean (1e7) the naive sum-of-squares formula
// loses ~10 ULPs of precision in sum_sq, so var collapses to zero or noise.
// A numerically stable algorithm (Welford et al.) recovers stddev to within 5%.
// -----------------------------------------------------------------------------
TEST_CASE("stats_pressure_stability_strict", "[stats]") {
    ChamberAggregator agg;
    std::mt19937 rng(1234);
    constexpr double kMean   = 1.0e7;
    constexpr double kStddev = 1.0e-6;
    std::normal_distribution<double> dist(kMean, kStddev);
    for (int i = 0; i < 50'000; ++i) {
        agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", dist(rng)));
    }
    auto stats = agg.compute_running_stats("ETCH-A1", "W1", "pressure_torr");
    REQUIRE(stats.has_value());
    REQUIRE(std::isfinite(stats->stddev));
    CHECK_THAT(stats->stddev, WithinRel(kStddev, 0.10));
    CHECK_THAT(stats->mean,   WithinAbs(kMean,   1e-3));
}

TEST_CASE("stats_mean_is_correct_for_simple_series", "[stats]") {
    ChamberAggregator agg;
    for (int i = 1; i <= 100; ++i) {
        agg.ingest(reading_at("C", "W", "s", static_cast<double>(i)));
    }
    auto stats = agg.compute_running_stats("C", "W", "s");
    REQUIRE(stats.has_value());
    CHECK_THAT(stats->mean,   WithinAbs(50.5, 1e-9));
    CHECK(stats->count == 100);
    CHECK_THAT(stats->min, WithinAbs(1.0, 1e-9));
    CHECK_THAT(stats->max, WithinAbs(100.0, 1e-9));
}

// -----------------------------------------------------------------------------
// [spc] — SPC excursions must be wired into ingest() and counted on the wafer
// record, and (when a reporter is supplied) forwarded to it.
// -----------------------------------------------------------------------------
TEST_CASE("spc_excursion_count_is_tracked_on_record", "[spc]") {
    ChamberAggregator agg;
    // Seed with enough in-control samples to cross kMinSamplesForControl=30
    // with a tight distribution.
    for (int i = 0; i < 200; ++i) {
        agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", 100.0));
    }
    // Inject a clear outlier well outside 3 sigma.
    agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", 1'000.0));

    agg.on_wafer_complete("ETCH-A1", "W1");
    auto records = agg.drain_completed();
    REQUIRE(records.size() == 1);
    CHECK(records[0].spc_excursion_count >= 1);
}

TEST_CASE("spc_excursions_forwarded_to_reporter", "[spc]") {
    std::atomic<std::uint64_t> delivered{0};
    auto sink = [&delivered](std::vector<Excursion> batch) {
        delivered += batch.size();
    };
    auto reporter = std::make_shared<ExcursionReporter>(sink);
    ChamberAggregator agg(reporter);

    for (int i = 0; i < 200; ++i) {
        agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", 100.0));
    }
    for (int i = 0; i < 5; ++i) {
        agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", 1'000.0 + i));
    }
    reporter->shutdown();
    CHECK(delivered.load() >= 5);
}

// -----------------------------------------------------------------------------
// [lifecycle] — Wafer completion must emit a record, free state, and drop late
// readings. Detects trap_late_reading_resurrection.
// -----------------------------------------------------------------------------
TEST_CASE("lifecycle_late_burst_after_completion", "[lifecycle]") {
    ChamberAggregator agg;
    for (int i = 0; i < 100; ++i) {
        agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", 100.0 + i));
    }
    agg.on_wafer_complete("ETCH-A1", "W1");
    (void)agg.drain_completed();

    for (int i = 0; i < 1'000; ++i) {
        agg.ingest(reading_at("ETCH-A1", "W1", "pressure_torr", 9'999.0));
    }
    CHECK(agg.live_wafer_count() == 0);
}

TEST_CASE("lifecycle_record_contains_per_sensor_stats", "[lifecycle]") {
    ChamberAggregator agg;
    for (int i = 0; i < 10; ++i) {
        agg.ingest(reading_at("C", "W", "pressure_torr", 100.0 + i));
        agg.ingest(reading_at("C", "W", "temp_c",        300.0 + i));
    }
    agg.on_wafer_complete("C", "W");
    auto records = agg.drain_completed();
    REQUIRE(records.size() == 1);
    CHECK(records[0].chamber_id == "C");
    CHECK(records[0].wafer_id   == "W");
    CHECK(records[0].per_sensor_stats.size() == 2);
    CHECK(agg.live_wafer_count() == 0);
}

TEST_CASE("lifecycle_multiple_wafers_complete_independently", "[lifecycle]") {
    ChamberAggregator agg;
    for (int i = 0; i < 5; ++i) {
        agg.ingest(reading_at("C", "W1", "s", static_cast<double>(i)));
        agg.ingest(reading_at("C", "W2", "s", static_cast<double>(i)));
    }
    CHECK(agg.live_wafer_count() == 2);
    agg.on_wafer_complete("C", "W1");
    CHECK(agg.live_wafer_count() == 1);
    agg.on_wafer_complete("C", "W2");
    CHECK(agg.live_wafer_count() == 0);
    CHECK(agg.drain_completed().size() == 2);
}

// -----------------------------------------------------------------------------
// [reporter] — ExcursionReporter contract. Detects trap_reporter_shutdown_leak.
// -----------------------------------------------------------------------------
TEST_CASE("reporter_destructor_drains_under_load", "[reporter]") {
    std::atomic<std::uint64_t> delivered{0};
    {
        auto sink = [&delivered](std::vector<Excursion> batch) {
            delivered += batch.size();
        };
        ExcursionReporter rep(sink);
        for (int i = 0; i < 10'000; ++i) {
            rep.report(Excursion{"C", "W", "s", 0.0, 0.0, 0.0,
                                 std::chrono::steady_clock::now()});
        }
    }  // ~ExcursionReporter must drain whatever was accepted.
    // With a non-dropping policy this is 10k. With a drop policy the reporter
    // must still deliver every excursion it accepted.
    CHECK(delivered.load() > 0);
    CHECK(delivered.load() <= 10'000);
}

TEST_CASE("reporter_shutdown_is_idempotent", "[reporter]") {
    auto sink = [](std::vector<Excursion>) {};
    ExcursionReporter rep(sink);
    rep.report(Excursion{"C", "W", "s", 0.0, 0.0, 0.0,
                         std::chrono::steady_clock::now()});
    rep.shutdown();
    rep.shutdown();  // must not crash or hang
    rep.report(Excursion{"C", "W", "s", 0.0, 0.0, 0.0,
                         std::chrono::steady_clock::now()});  // no-op after shutdown
    SUCCEED("shutdown is idempotent and report after shutdown is safe");
}

TEST_CASE("reporter_concurrent_report_accounting_matches", "[reporter]") {
    std::atomic<std::uint64_t> delivered{0};
    auto sink = [&delivered](std::vector<Excursion> batch) {
        delivered += batch.size();
    };
    ExcursionReporter rep(sink);

    constexpr int kThreads   = 8;
    constexpr int kPerThread = 2'000;
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

    CHECK(rep.delivered_count() == delivered.load());
    CHECK(rep.accepted_count()  <= static_cast<std::uint64_t>(kThreads * kPerThread));
    CHECK(rep.delivered_count() <= rep.accepted_count());
}
