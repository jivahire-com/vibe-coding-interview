#pragma once

#include "sensor_reading.h"

namespace wafer {

// Statistical Process Control (SPC) limits.
//
// REFERENCE IMPLEMENTATION — this file is intentionally complete and correct.
// You may read it freely and reference it from your prompts (e.g. "follow the
// same pattern used in spc_limits.cpp"). You should not need to modify it.
class SpcLimits {
public:
    // Minimum samples before SPC limits are considered trustworthy.
    // Below this, is_excursion() always returns false.
    static constexpr std::uint64_t kMinSamplesForControl = 30;

    // Sigma multiplier for the upper/lower control limit (UCL/LCL).
    // 3.0 is the textbook Western Electric rule for "out of control".
    static constexpr double kSigmaMultiplier = 3.0;

    // Returns true iff |reading.value - stats.mean| > kSigmaMultiplier * stats.stddev.
    // - If stats.count < kMinSamplesForControl, returns false.
    // - If stats.stddev == 0, returns false (degenerate distribution; no excursion possible).
    [[nodiscard]] static bool is_excursion(const SensorReading& reading,
                                           const RunningStats&  stats) noexcept;
};

}  // namespace wafer
