from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str
    llm_base_url: str = "https://openrouter.ai/api/v1"
    github_bot_pat: str
    github_challenges_repo: str
    admin_token: str
    db_path: str = "vibe.db"
    host: str = "0.0.0.0"
    port: int = 8080
    challenges_dir: str = "challenges"


settings = Settings()
