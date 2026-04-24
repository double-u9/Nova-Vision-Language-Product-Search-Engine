from __future__ import annotations

import io
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import uvicorn
import yaml
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from embedder import CLIPEmbedder
from indexer import ProductIndex
from pipeline import SearchPipeline
from reranker import RerankerEngine

logging.basicConfig(
  level=os.getenv("LOG_LEVEL", "INFO"),
  format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("nova.api")

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.getenv("NOVA_CONFIG_PATH", BASE_DIR / "config.yaml")).resolve()
DATA_DIR = Path(os.getenv("NOVA_DATA_DIR", BASE_DIR / "data")).resolve()
IMAGE_DIR = Path(
  os.getenv("NOVA_IMAGE_DIR", DATA_DIR / "fashionIQ_dataset" / "images"),
).resolve()
INDEX_PATH = Path(os.getenv("NOVA_INDEX_PATH", DATA_DIR / "faiss.index")).resolve()
METADATA_DB_PATH = Path(
  os.getenv("NOVA_METADATA_DB_PATH", DATA_DIR / "products.db"),
).resolve()
DEFAULT_TOP_K = int(os.getenv("NOVA_DEFAULT_TOP_K", "30"))
MAX_TOP_K = int(os.getenv("NOVA_MAX_TOP_K", "60"))

_pipeline: Optional[SearchPipeline] = None
_request_count = 0
_total_latency = 0.0
_startup_error: Optional[str] = None
_category_lookup: dict[str, str] = {}


def _parse_cors_origins() -> list[str]:
  raw = os.getenv(
    "NOVA_CORS_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
  )
  return [origin.strip() for origin in raw.split(",") if origin.strip()]


def _load_config() -> dict:
  with CONFIG_PATH.open("r", encoding="utf-8") as handle:
    config = yaml.safe_load(handle)

  config.setdefault("model", {})
  config.setdefault("index", {})
  config.setdefault("retrieval", {})
  config.setdefault("reranker", {})

  config["index"]["index_path"] = str(INDEX_PATH)
  config["index"]["metadata_db"] = str(METADATA_DB_PATH)
  config.setdefault("data", {})
  config["data"]["image_dir"] = str(IMAGE_DIR)

  return config


def _load_category_lookup() -> dict[str, str]:
  lookup: dict[str, str] = {}
  image_splits_dir = DATA_DIR / "fashionIQ_dataset" / "image_splits"

  if not image_splits_dir.exists():
    logger.warning("Image split directory not found at %s", image_splits_dir)
    return lookup

  for split_file in image_splits_dir.glob("split.*.*.json"):
    parts = split_file.stem.split(".")
    if len(parts) < 3:
      continue

    category = parts[1]

    try:
      with split_file.open("r", encoding="utf-8") as handle:
        image_ids = json.load(handle)
    except json.JSONDecodeError as error:
      logger.warning("Skipping invalid split file %s: %s", split_file, error)
      continue

    for image_id in image_ids:
      lookup[str(image_id)] = category

  logger.info("Loaded %s category labels from FashionIQ splits", len(lookup))
  return lookup


def _format_results(raw_results) -> list[dict]:
  formatted = []

  for result in raw_results:
    product_id = result["product_id"]
    raw_category = result.get("category") or "unknown"
    category = raw_category if raw_category != "unknown" else _category_lookup.get(product_id, "unknown")

    formatted.append(
      {
        "product_id": product_id,
        "image_path": result.get("image_path", ""),
        "category": category,
        "score": result.get("rerank_score", result.get("score", 0.0)),
        "rank": result.get("rerank", result.get("rank", 0)),
      },
    )

  return formatted


def _track_request(latency_ms: float) -> None:
  global _request_count, _total_latency
  _request_count += 1
  _total_latency += latency_ms


def _ensure_pipeline_ready() -> SearchPipeline:
  if _pipeline is not None:
    return _pipeline

  if _startup_error:
    raise HTTPException(503, f"Pipeline unavailable: {_startup_error}")

  raise HTTPException(503, "Pipeline is still starting")


def _choose_upload(primary: UploadFile | None, secondary: UploadFile | None) -> UploadFile:
  upload = primary or secondary
  if upload is None:
    raise HTTPException(422, "An image upload is required")
  return upload


def _normalize_top_k(value: int) -> int:
  return max(1, min(value, MAX_TOP_K))


def _build_pipeline() -> SearchPipeline:
  config = _load_config()
  batch_size = config["model"].get("batch_size_cpu", 64)
  reranker = None

  if config["reranker"].get("enabled"):
    reranker = RerankerEngine(model_path=config["reranker"]["model_path"])

  embedder = CLIPEmbedder(
    model_name=config["model"].get("name", "ViT-B/32"),
    device=config["model"].get("device", "auto"),
    batch_size=batch_size,
  )
  index = ProductIndex(
    embedding_dim=config["model"].get("embedding_dim", 512),
    index_type=config["index"].get("type", "auto"),
    nlist=config["index"].get("nlist", 256),
    nprobe=config["index"].get("nprobe", 32),
    m=config["index"].get("m", 64),
    nbits=config["index"].get("nbits", 8),
    index_path=str(INDEX_PATH),
    db_path=str(METADATA_DB_PATH),
  )
  index.load()

  return SearchPipeline(
    embedder=embedder,
    index=index,
    reranker=reranker,
    top_k_candidates=max(config["retrieval"].get("top_k_candidates", 50), DEFAULT_TOP_K),
    top_k_final=max(config["retrieval"].get("top_k_final", 5), DEFAULT_TOP_K),
    cache_size=config["retrieval"].get("cache_size", 128),
  )


@asynccontextmanager
async def lifespan(_: FastAPI):
  global _pipeline, _startup_error, _category_lookup

  try:
    logger.info("Loading Nova search pipeline")
    _category_lookup = _load_category_lookup()
    _pipeline = _build_pipeline()
    _startup_error = None
    logger.info("Nova search pipeline ready with %s indexed products", len(_pipeline.index))
  except Exception as error:  # pragma: no cover - exercised in runtime validation
    _startup_error = str(error)
    _pipeline = None
    logger.exception("Nova API failed to initialize")

  yield

  logger.info("Shutting down Nova API")


class TextSearchRequest(BaseModel):
  query: str = Field(..., min_length=1, description="Natural language product query")
  category: str = Field("default", description="Product category hint")
  top_k: int = Field(DEFAULT_TOP_K, ge=1, le=MAX_TOP_K)
  refresh: bool = False
  latency_target: int | None = None


class ProductResult(BaseModel):
  product_id: str
  image_path: str
  category: str
  score: float
  rank: int


class SearchResponse(BaseModel):
  results: list[ProductResult]
  query_type: str
  latency_ms: float
  cache_hit: bool
  alpha: float | None = None


app = FastAPI(
  title="Nova Product Search API",
  description="Vision-language product retrieval powered by CLIP and FAISS",
  version="1.0.0",
  lifespan=lifespan,
)

app.add_middleware(
  CORSMiddleware,
  allow_origins=_parse_cors_origins(),
  allow_methods=["*"],
  allow_headers=["*"],
)

if IMAGE_DIR.exists():
  app.mount("/images", StaticFiles(directory=str(IMAGE_DIR)), name="images")
else:
  logger.warning("Image directory not found at %s", IMAGE_DIR)


@app.get("/health")
def health():
  if _pipeline is not None:
    status = "ok"
    index_size = len(_pipeline.index)
  elif _startup_error:
    status = "degraded"
    index_size = 0
  else:
    status = "starting"
    index_size = 0

  return {
    "status": status,
    "index_size": index_size,
    "requests_served": _request_count,
    "avg_latency_ms": round(_total_latency / max(_request_count, 1), 2),
    "startup_error": _startup_error,
  }


@app.get("/metrics")
def metrics():
  lines = [
    "# HELP nova_requests_total Total search requests served",
    "# TYPE nova_requests_total counter",
    f"nova_requests_total {_request_count}",
    "# HELP nova_avg_latency_ms Average query latency in ms",
    "# TYPE nova_avg_latency_ms gauge",
    f"nova_avg_latency_ms {_total_latency / max(_request_count, 1):.2f}",
  ]
  return PlainTextResponse("\n".join(lines))


@app.post("/search/text", response_model=SearchResponse)
def search_text(request: TextSearchRequest):
  pipeline = _ensure_pipeline_ready()
  result = pipeline.search(
    text=request.query,
    category=request.category,
    top_k=_normalize_top_k(request.top_k),
    use_cache=not request.refresh,
  )
  _track_request(result["latency_ms"])
  return SearchResponse(
    results=_format_results(result["results"]),
    query_type=result["query_type"],
    latency_ms=result["latency_ms"],
    cache_hit=result["cache_hit"],
    alpha=result["alpha"],
  )


@app.post("/search/image", response_model=SearchResponse)
async def search_image(
  image: UploadFile | None = File(None),
  file: UploadFile | None = File(None),
  top_k: int = Form(DEFAULT_TOP_K),
  refresh: bool = Form(False),
  latency_target: int | None = Form(None),
):
  del latency_target
  pipeline = _ensure_pipeline_ready()
  upload = _choose_upload(image, file)

  contents = await upload.read()
  pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
  result = pipeline.search(
    image=pil_image,
    top_k=_normalize_top_k(top_k),
    use_cache=not refresh,
  )
  _track_request(result["latency_ms"])
  return SearchResponse(
    results=_format_results(result["results"]),
    query_type=result["query_type"],
    latency_ms=result["latency_ms"],
    cache_hit=result["cache_hit"],
    alpha=result["alpha"],
  )


@app.post("/search/hybrid", response_model=SearchResponse)
async def search_hybrid(
  query: str | None = Form(None),
  text: str | None = Form(None),
  image: UploadFile | None = File(None),
  file: UploadFile | None = File(None),
  category: str = Form("default"),
  alpha: Optional[float] = Form(None),
  top_k: int = Form(DEFAULT_TOP_K),
  refresh: bool = Form(False),
  latency_target: int | None = Form(None),
):
  del latency_target
  pipeline = _ensure_pipeline_ready()
  upload = _choose_upload(image, file)
  query_text = (query or text or "").strip()

  if not query_text:
    raise HTTPException(422, "A text query is required for hybrid search")

  contents = await upload.read()
  pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
  result = pipeline.search(
    text=query_text,
    image=pil_image,
    category=category,
    alpha=alpha,
    top_k=_normalize_top_k(top_k),
    use_cache=not refresh,
  )
  _track_request(result["latency_ms"])
  return SearchResponse(
    results=_format_results(result["results"]),
    query_type=result["query_type"],
    latency_ms=result["latency_ms"],
    cache_hit=result["cache_hit"],
    alpha=result["alpha"],
  )


if __name__ == "__main__":
  host = os.getenv("NOVA_HOST", os.getenv("BACKEND_HOST", "127.0.0.1"))
  port = int(os.getenv("NOVA_PORT", os.getenv("BACKEND_PORT", "5000")))
  uvicorn.run("server:app", host=host, port=port, reload=False)
