#pragma once

#include "sensor_reading.h"
#include "excursion_reporter.h"

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace wafer {

// Aggregates sensor readings per (chamber_id, wafer_id, sensor_name).
//
// PARTIAL implementation — bugs are present, several methods are TODO.
// The chosen storage layout (nested unordered_maps keyed by chamber/wafer/sensor)
// is fixed; do not change the public interface.
class ChamberAggregator {
public:
    // `reporter` is optional; if provided, excursions are forwarded to it.
    explicit ChamberAggregator(std::shared_ptr<ExcursionReporter> reporter = nullptr);
    ~ChamberAggregator();

    ChamberAggregator(const ChamberAggregator&)            = delete;
    ChamberAggregator& operator=(const ChamberAggregator&) = delete;

    // Hot path. Called concurrently from many sensor-ingestion threads
    // (typically one per chamber, ~1000 samples/sec/chamber).
    // Late readings for a wafer that has already completed must be dropped.
    void ingest(const SensorReading& reading);

    // Snapshot of the current per-sensor stats. Returns std::nullopt if the
    // (chamber, wafer, sensor) is unknown.
    [[nodiscard]] std::optional<RunningStats>
    compute_running_stats(const std::string& chamber_id,
                          const std::string& wafer_id,
                          const std::string& sensor_name) const;

    // Finalise a wafer: build a WaferRecord, push it to the completed queue,
    // free per-wafer state, and remember the wafer so late readings are dropped.
    void on_wafer_complete(const std::string& chamber_id,
                           const std::string& wafer_id);

    // Drain all currently-completed records (consumer thread calls this).
    [[nodiscard]] std::vector<WaferRecord> drain_completed();

    // For tests/diagnostics.
    [[nodiscard]] std::uint64_t live_wafer_count() const;

private:
    struct PerSensorState {
        std::uint64_t count  = 0;
        double        mean   = 0.0;
        // NOTE: the starter accumulates raw sums; this is numerically poor.
        // See README Task 2.
        double        sum    = 0.0;
        double        sum_sq = 0.0;
        double        min    = 0.0;
        double        max    = 0.0;
    };

    struct PerWaferState {
        // sensor_name -> stats
        std::unordered_map<std::string, PerSensorState> sensors;
        std::uint64_t                                   spc_excursion_count = 0;
    };

    // chamber_id -> wafer_id -> wafer state
    std::unordered_map<std::string,
        std::unordered_map<std::string, PerWaferState>>      live_;

    // Records ready to be drained.
    std::vector<WaferRecord>                                  completed_;

    // Set of (chamber_id, wafer_id) that have completed — used to silently drop
    // late readings. Bounded retention is left as a follow-up; not graded.
    std::unordered_map<std::string,
        std::unordered_map<std::string, bool>>                completed_set_;

    std::shared_ptr<ExcursionReporter>                        reporter_;

    // TODO(candidate, Task 1): add synchronisation. None is provided.
};

}  // namespace wafer
