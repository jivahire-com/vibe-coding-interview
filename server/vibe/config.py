from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).parent.parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_ENV_FILE), extra="ignore")

    openai_api_key: str
    llm_base_url: str = "https://openrouter.ai/api/v1"
    github_bot_pat: str
    # Org/user under which per-challenge repos live: <owner>/<challenge_id>.
    # When set, the repo for a session is derived from its challenge_id.
    github_challenges_owner: str = ""
    # Legacy single-repo fallback. Used only when github_challenges_owner is unset.
    github_challenges_repo: str = ""
    admin_token: str
    db_path: str = "vibe.db"
    host: str = "0.0.0.0"
    port: int = 8080
    challenges_dir: str = "challenges"
    chat_model: str = "openai/gpt-4o-mini"
    grader_model: str = "openai/gpt-4o-mini"
    candidate_chat_models: str = (
        "openai/gpt-4o-mini,"
        "google/gemini-2.5-flash-lite,"
        "anthropic/claude-opus-4.6,"
        "anthropic/claude-sonnet-4.6"
    )
    grader_self_consistency_n: int = 1
    sendgrid_api_key: str = ""
    from_email: str = "noreply@jivahire.com"
    app_public_url: str = "http://localhost:8080"

    # Post-submit video explainer storage. Empty bucket/domain disables the
    # feature (init endpoint returns 503). boto3 picks up AWS credentials
    # from the standard chain: IAM role on ECS/EC2, else AWS_ACCESS_KEY_ID
    # env vars. Playback URLs are public CloudFront URLs — anyone with the
    # link can view; treat that as a known tradeoff.
    aws_region: str = "us-east-1"
    s3_video_bucket: str = ""
    cloudfront_domain: str = ""


settings = Settings()


def repo_for_challenge(challenge_id: str) -> str:
    if settings.github_challenges_owner:
        return f"{settings.github_challenges_owner}/{challenge_id}"
    return settings.github_challenges_repo
