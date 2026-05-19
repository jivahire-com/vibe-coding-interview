#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace wafer {

// Immutable sample emitted by a sensor in a process chamber.
// The schema is fixed — do not modify it; the demo and tests rely on it.
struct SensorReading {
    std::string  chamber_id;        // e.g. "ETCH-A1"
    std::string  wafer_id;          // e.g. "LOT2026A.W14"
    std::string  sensor_name;       // e.g. "pressure_torr"
    double       value;
    std::chrono::steady_clock::time_point ts;
};

// Per-sensor running statistics, as returned by ChamberAggregator::compute_running_stats().
struct RunningStats {
    std::uint64_t count = 0;
    double        mean   = 0.0;
    double        stddev = 0.0;
    double        min    = 0.0;
    double        max    = 0.0;
};

// Final record emitted when a wafer leaves the chamber.
struct WaferRecord {
    std::string                                            chamber_id;
    std::string                                            wafer_id;
    // sensor_name -> stats
    std::vector<std::pair<std::string, RunningStats>>      per_sensor_stats;
    std::uint64_t                                          spc_excursion_count = 0;
    std::chrono::steady_clock::time_point                  finalized_at{};
};

// Single SPC excursion event handed to the ExcursionReporter (Task 5).
struct Excursion {
    std::string                            chamber_id;
    std::string                            wafer_id;
    std::string                            sensor_name;
    double                                 value      = 0.0;
    double                                 mean       = 0.0;
    double                                 stddev     = 0.0;
    std::chrono::steady_clock::time_point  ts{};
};

}  // namespace wafer
