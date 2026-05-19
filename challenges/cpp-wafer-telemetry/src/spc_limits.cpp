#include "spc_limits.h"

#include <cmath>

namespace wafer {

bool SpcLimits::is_excursion(const SensorReading& reading,
                             const RunningStats&  stats) noexcept {
    if (stats.count < kMinSamplesForControl) {
        return false;
    }
    if (!(stats.stddev > 0.0)) {
        // Catches stddev == 0 and NaN. A degenerate distribution has no excursion.
        return false;
    }
    const double deviation = std::fabs(reading.value - stats.mean);
    return deviation > kSigmaMultiplier * stats.stddev;
}

}  // namespace wafer
