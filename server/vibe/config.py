from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).parent.parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_ENV_FILE), extra="ignore")

    openai_api_key: str
    llm_base_url: str = "https://openrouter.ai/api/v1"
    github_bot_pat: str
    github_challenges_repo: str
    admin_token: str
    db_path: str = "vibe.db"
    host: str = "0.0.0.0"
    port: int = 8080
    challenges_dir: str = "challenges"
    chat_model: str = "openai/gpt-4o-mini"
    sendgrid_api_key: str = ""
    from_email: str = "noreply@jivahire.com"
    app_public_url: str = "http://localhost:8080"


settings = Settings()
