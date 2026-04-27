import tiktoken

MODEL = "openai/gpt-4o-mini"
INPUT_USD_PER_M = 0.15
OUTPUT_USD_PER_M = 0.60

_enc = tiktoken.get_encoding("o200k_base")


def count_tokens(text: str) -> int:
    return len(_enc.encode(text))


def estimate_prompt_cost(messages: list[dict]) -> float:
    tokens = sum(count_tokens(m["content"]) for m in messages)
    tokens += len(messages) * 4  # per-message overhead
    return tokens / 1_000_000 * INPUT_USD_PER_M


def compute_cost(prompt_tokens: int, completion_tokens: int) -> float:
    return (
        prompt_tokens / 1_000_000 * INPUT_USD_PER_M
        + completion_tokens / 1_000_000 * OUTPUT_USD_PER_M
    )
