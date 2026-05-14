FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake g++ make ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev
COPY server/ ./server/
COPY challenges/ ./challenges/
ENV PYTHONPATH=/app/server
CMD ["uv", "run", "python", "-m", "vibe.worker"]
