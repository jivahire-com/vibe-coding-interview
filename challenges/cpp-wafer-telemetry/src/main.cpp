// Demo: feeds synthetic sensor readings from a few "chambers" through the
// aggregator, prints WaferRecord summaries when wafers complete, and drains
// any excursions through a console sink.
//
// You should not need to modify this file. It exists so you can run the
// pipeline end-to-end while iterating on the library.

#include "chamber_aggregator.h"
#include "excursion_reporter.h"
#include "sensor_reading.h"

#include <chrono>
#include <iostream>
#include <random>
#include <thread>

using wafer::ChamberAggregator;
using wafer::Excursion;
using wafer::ExcursionReporter;
using wafer::SensorReading;

namespace {

void console_sink(std::vector<Excursion> batch) {
    for (const auto& e : batch) {
        std::cout << "[EXCURSION] " << e.chamber_id << " / " << e.wafer_id
                  << " / " << e.sensor_name << " value=" << e.value
                  << " mean=" << e.mean << " stddev=" << e.stddev << '\n';
    }
}

void chamber_thread(ChamberAggregator& agg,
                    const std::string& chamber_id,
                    const std::string& wafer_id) {
    std::mt19937 rng(std::hash<std::string>{}(chamber_id));
    std::normal_distribution<double> noise(760.0, 0.001);  // pressure_torr
    for (int i = 0; i < 5000; ++i) {
        SensorReading r{
            chamber_id, wafer_id, "pressure_torr",
            noise(rng),
            std::chrono::steady_clock::now()
        };
        agg.ingest(r);
    }
    agg.on_wafer_complete(chamber_id, wafer_id);
}

}  // namespace

int main() {
    auto reporter = std::make_shared<ExcursionReporter>(console_sink);
    ChamberAggregator agg(reporter);

    std::thread t1(chamber_thread, std::ref(agg), "ETCH-A1", "LOT2026A.W14");
    std::thread t2(chamber_thread, std::ref(agg), "DEPO-B2", "LOT2026A.W15");
    t1.join();
    t2.join();

    for (const auto& rec : agg.drain_completed()) {
        std::cout << "[WAFER] " << rec.chamber_id << " / " << rec.wafer_id
                  << " sensors=" << rec.per_sensor_stats.size()
                  << " excursions=" << rec.spc_excursion_count << '\n';
    }

    reporter->shutdown();
    return 0;
}
