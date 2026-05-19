#include "chamber_aggregator.h"

#include "spc_limits.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace wafer {

ChamberAggregator::ChamberAggregator(std::shared_ptr<ExcursionReporter> reporter)
    : reporter_(std::move(reporter)) {}

ChamberAggregator::~ChamberAggregator() = default;

// -----------------------------------------------------------------------------
// Hot path. Called from many threads concurrently.
// PLANTED BUG (Task 1): no synchronisation around mutations to live_.
// PLANTED BUG (Task 2): naive sum-of-squares accumulator is numerically unstable
//                       for large-mean / small-variance signals (e.g. pressure
//                       readings around 760 Torr ± 0.001).
// -----------------------------------------------------------------------------
void ChamberAggregator::ingest(const SensorReading& reading) {
    // Late-arrival check is missing — see Task 4.

    auto& chamber = live_[reading.chamber_id];
    auto& wafer   = chamber[reading.wafer_id];
    auto& s       = wafer.sensors[reading.sensor_name];

    if (s.count == 0) {
        s.min = reading.value;
        s.max = reading.value;
    } else {
        s.min = std::min(s.min, reading.value);
        s.max = std::max(s.max, reading.value);
    }

    s.count  += 1;
    s.sum    += reading.value;
    s.sum_sq += reading.value * reading.value;
    s.mean    = s.sum / static_cast<double>(s.count);

    // Excursion detection / reporting is NOT wired up yet — see Task 3.
}

// -----------------------------------------------------------------------------
// PARTIAL: stddev uses the textbook sum-of-squares formula. This loses precision
// catastrophically for large-magnitude / small-variance series. Replace with a
// numerically stable single-pass algorithm (see Task 2).
// -----------------------------------------------------------------------------
std::optional<RunningStats>
ChamberAggregator::compute_running_stats(const std::string& chamber_id,
                                         const std::string& wafer_id,
                                         const std::string& sensor_name) const {
    auto cit = live_.find(chamber_id);
    if (cit == live_.end()) return std::nullopt;
    auto wit = cit->second.find(wafer_id);
    if (wit == cit->second.end()) return std::nullopt;
    auto sit = wit->second.sensors.find(sensor_name);
    if (sit == wit->second.sensors.end()) return std::nullopt;

    const auto& s = sit->second;
    RunningStats out;
    out.count = s.count;
    out.mean  = s.mean;
    out.min   = s.min;
    out.max   = s.max;
    if (s.count > 1) {
        const double n   = static_cast<double>(s.count);
        const double var = (s.sum_sq - (s.sum * s.sum) / n) / (n - 1.0);
        out.stddev = var > 0.0 ? std::sqrt(var) : 0.0;
    }
    return out;
}

// -----------------------------------------------------------------------------
// TODO(candidate, Task 4): build a WaferRecord, enqueue it, free per-wafer state,
// and mark the wafer as completed so future ingest() calls drop late readings.
// -----------------------------------------------------------------------------
void ChamberAggregator::on_wafer_complete(const std::string& /*chamber_id*/,
                                          const std::string& /*wafer_id*/) {
    // Intentionally empty.
}

std::vector<WaferRecord> ChamberAggregator::drain_completed() {
    std::vector<WaferRecord> out;
    out.swap(completed_);
    return out;
}

std::uint64_t ChamberAggregator::live_wafer_count() const {
    std::uint64_t n = 0;
    for (const auto& [chamber_id, wafers] : live_) {
        n += wafers.size();
    }
    return n;
}

}  // namespace wafer
