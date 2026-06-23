FROM python:3.12-slim
WORKDIR /app
# git + CA certs: the recruiter code-diff endpoint clones the candidate's
# branch over HTTPS to compute a starter-vs-final diff (see vibe/code_diff.py).
# The python:slim base ships neither.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev
COPY server/ ./server/
COPY challenges/ ./challenges/
COPY extension/*.vsix ./extension/
ENV PYTHONPATH=/app/server
EXPOSE 8080
CMD ["uv", "run", "uvicorn", "vibe.main:app", "--host", "0.0.0.0", "--port", "8080"]
