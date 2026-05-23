import os
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from vibe.db import bootstrap
from vibe.logging_config import configure_logging, request_id_middleware
from vibe.sessions import router as sessions_router
from vibe.telemetry import router as telemetry_router
from vibe.submit import router as submit_router
from vibe.llm_proxy import router as llm_router, backfill_candidate_tokens
from vibe.challenges_page import router as challenges_page_router
from vibe.author_docs import router as author_docs_router
from vibe.video import router as video_router, public_router as video_public_router
from vibe.app_logs import router as app_logs_router

configure_logging("server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    bootstrap()
    threading.Thread(target=backfill_candidate_tokens, daemon=True).start()
    yield


app = FastAPI(title="Vibe Interview Server", lifespan=lifespan)
app.middleware("http")(request_id_middleware)
app.include_router(sessions_router)
app.include_router(telemetry_router)
app.include_router(submit_router)
app.include_router(llm_router)
app.include_router(challenges_page_router)
app.include_router(author_docs_router)
app.include_router(video_router)
app.include_router(app_logs_router)
# Must be registered before the static `/` mount so /video-record reaches it.
app.include_router(video_public_router)

from fastapi.responses import FileResponse

_static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
_ext_dir = os.path.join(os.path.dirname(__file__), "..", "..", "extension")

def _find_vsix() -> str:
    import glob, re
    matches = glob.glob(os.path.join(_ext_dir, "jivahire-vibe-coding-interview-*.vsix"))
    # Version-aware sort: lexicographic sort puts 0.1.10 before 0.1.2, so a
    # plain sorted()[-1] would serve a stale older build. Extract numeric
    # version components and compare as tuples instead.
    def _key(path: str) -> tuple:
        m = re.search(r"jivahire-vibe-coding-interview-(\d+(?:\.\d+)*)\.vsix$", path)
        return tuple(int(p) for p in m.group(1).split(".")) if m else ()
    matches.sort(key=_key)
    return os.path.abspath(matches[-1]) if matches else ""

@app.get("/jivahire-vibe-coding-interview.vsix", include_in_schema=False)
def download_vsix():
    vsix = _find_vsix()
    if not vsix:
        from fastapi import HTTPException
        raise HTTPException(404, "VSIX not found")
    return FileResponse(vsix,
                        media_type="application/octet-stream",
                        filename="jivahire-vibe-coding-interview.vsix")

if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
