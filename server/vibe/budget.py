INPUT_USD_PER_M = 0.15
CACHED_INPUT_USD_PER_M = 0.075
OUTPUT_USD_PER_M = 0.60


def compute_cost(
    prompt_tokens: int,
    completion_tokens: int,
    cached_input_tokens: int = 0,
) -> float:
    uncached_prompt = max(0, prompt_tokens - cached_input_tokens)
    return (
        uncached_prompt / 1_000_000 * INPUT_USD_PER_M
        + cached_input_tokens / 1_000_000 * CACHED_INPUT_USD_PER_M
        + completion_tokens / 1_000_000 * OUTPUT_USD_PER_M
    )
