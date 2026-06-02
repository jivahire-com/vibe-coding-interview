# Per-million-token pricing for every model the candidate chat picker offers.
# Keep this table in sync with extension/src/api.ts:DEFAULT_MODEL_PRICING so the
# extension's local spend meter never diverges from the server's enforcement.
#
# Sources (late 2025 / early 2026):
#   - openai/gpt-4o           — OpenAI list price ($2.50/$10, 50% cached input)
#   - anthropic/claude-opus-4.6    — Anthropic list price ($15/$75, $1.50 cached)
#   - anthropic/claude-sonnet-4.6  — Anthropic list price ($3/$15, $0.30 cached)
#   - anthropic/claude-haiku-4.5   — Anthropic list price ($1/$5, $0.10 cached)
#   - openai/gpt-4o-mini      — OpenAI list price; retained for the internal
#     grader_model (no longer in the candidate picker)
#
# `cached_input` is the prompt-cache hit rate (OpenAI / Anthropic "cached"
# input). When a provider does not publish a cache discount we fall back to
# the regular input rate so cost is never under-counted.
MODEL_PRICING: dict[str, dict[str, float]] = {
    "openai/gpt-4o": {
        "input": 2.50,
        "cached_input": 1.25,
        "output": 10.0,
    },
    "anthropic/claude-haiku-4.5": {
        "input": 1.0,
        "cached_input": 0.10,
        "output": 5.0,
    },
    "openai/gpt-4o-mini": {
        "input": 0.15,
        "cached_input": 0.075,
        "output": 0.60,
    },
    "anthropic/claude-opus-4.6": {
        "input": 15.0,
        "cached_input": 1.50,
        "output": 75.0,
    },
    "anthropic/claude-sonnet-4.6": {
        "input": 3.0,
        "cached_input": 0.30,
        "output": 15.0,
    },
}

# Default model — used when compute_cost / pricing_for is called without an
# explicit model id. Mirrors the historical hard-coded GPT-4o-mini rates so
# pre-existing callers (and any rows in chat_exchanges that pre-date the
# multi-model table) keep their billing semantics.
_DEFAULT_MODEL = "openai/gpt-4o-mini"

# Back-compat exports — older code imports these directly from this module.
INPUT_USD_PER_M = MODEL_PRICING[_DEFAULT_MODEL]["input"]
CACHED_INPUT_USD_PER_M = MODEL_PRICING[_DEFAULT_MODEL]["cached_input"]
OUTPUT_USD_PER_M = MODEL_PRICING[_DEFAULT_MODEL]["output"]


def pricing_for(model: str | None) -> dict[str, float]:
    """Return the pricing entry for *model*, falling back to the default
    model's rates for unknown ids. The proxy already rejects unknown models
    via the allowlist, so this fallback only matters for legacy rows / tests.
    """
    if model and model in MODEL_PRICING:
        return MODEL_PRICING[model]
    return MODEL_PRICING[_DEFAULT_MODEL]


def compute_cost(
    prompt_tokens: int,
    completion_tokens: int,
    cached_input_tokens: int = 0,
    model: str | None = None,
) -> float:
    rates = pricing_for(model)
    uncached_prompt = max(0, prompt_tokens - cached_input_tokens)
    return (
        uncached_prompt / 1_000_000 * rates["input"]
        + cached_input_tokens / 1_000_000 * rates["cached_input"]
        + completion_tokens / 1_000_000 * rates["output"]
    )
