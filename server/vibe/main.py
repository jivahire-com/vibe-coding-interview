from contextlib import asynccontextmanager
from fastapi import FastAPI
from vibe.db import bootstrap
from vibe.sessions import router as sessions_router
from vibe.telemetry import router as telemetry_router
from vibe.submit import router as submit_router
from vibe.llm_proxy import router as llm_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    bootstrap()
    yield


app = FastAPI(title="Vibe Interview Server", lifespan=lifespan)
app.include_router(sessions_router)
app.include_router(telemetry_router)
app.include_router(submit_router)
app.include_router(llm_router)
