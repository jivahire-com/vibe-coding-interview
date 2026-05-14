import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
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

from fastapi.responses import FileResponse

_static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
_ext_dir = os.path.join(os.path.dirname(__file__), "..", "..", "extension")

def _find_vsix() -> str:
    import glob
    matches = sorted(glob.glob(os.path.join(_ext_dir, "jivahire-vibe-coding-interview-*.vsix")))
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
