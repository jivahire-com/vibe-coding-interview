FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev
COPY server/ ./server/
COPY challenges/ ./challenges/
COPY extension/*.vsix ./extension/
ENV PYTHONPATH=/app/server
EXPOSE 8080
CMD ["uv", "run", "uvicorn", "vibe.main:app", "--host", "0.0.0.0", "--port", "8080"]
