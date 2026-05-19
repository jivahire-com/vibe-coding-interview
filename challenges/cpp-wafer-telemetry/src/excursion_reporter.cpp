// Task 5 STARTER STUB — replace this file's contents with a real implementation.
//
// This stub exists so the project links and tests for tasks 1-4 can run. Every
// method here is intentionally a no-op or returns 0; the [reporter] tests will
// fail until you implement them properly. See excursion_reporter.h for the
// behaviour contract.
//
// You are free to replace Impl entirely, change member layout, add worker
// threads, queues, condition variables, etc. The header is the contract; this
// file is yours.

#include "excursion_reporter.h"

namespace wafer {

struct ExcursionReporter::Impl {
    // TODO(candidate, Task 5): put queue, worker thread, mutex, etc. here.
};

ExcursionReporter::ExcursionReporter(SinkFn /*sink*/, Config /*cfg*/)
    : impl_(std::make_unique<Impl>()) {}

ExcursionReporter::~ExcursionReporter() = default;

void ExcursionReporter::report(const Excursion& /*e*/) {
    // Stub: drop everything.
}

void ExcursionReporter::shutdown() {
    // Stub: nothing to drain.
}

std::uint64_t ExcursionReporter::accepted_count() const noexcept { return 0; }
std::uint64_t ExcursionReporter::delivered_count() const noexcept { return 0; }

}  // namespace wafer
