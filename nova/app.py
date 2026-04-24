"""
app.py
──────
Streamlit web UI for Nova — Vision-Language Product Search Engine.

Features:
  - Text search
  - Image upload search
  - Hybrid (text + image) search
  - Top-5 results grid with scores
  - Query latency display
  - Category filter
"""

import io
import logging
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import streamlit as st
from PIL import Image

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nova.ui")


# ─── Page config ─────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="Nova — Product Search",
    page_icon="🔍",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─── CSS ─────────────────────────────────────────────────────────────────────
st.markdown("""
<style>
  .result-card {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 8px;
    background: #fafafa;
  }
  .score-badge {
    background: #0f62fe;
    color: white;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
  }
  .latency-pill {
    background: #24a148;
    color: white;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 13px;
  }
  h1 { font-family: 'IBM Plex Sans', sans-serif; }
</style>
""", unsafe_allow_html=True)


# ─── Pipeline loader (cached) ─────────────────────────────────────────────────
@st.cache_resource(show_spinner="Loading search engine...")
def load_pipeline():
    """Load and cache the full search pipeline at startup."""
    import yaml
    from embedder import CLIPEmbedder
    from indexer import ProductIndex
    from reranker import RerankerEngine
    from pipeline import SearchPipeline

    with open("config.yaml") as f:
        cfg = yaml.safe_load(f)

    embedder = CLIPEmbedder(
        model_name=cfg["model"]["name"],
        device=cfg["model"]["device"],
        batch_size=cfg["model"]["batch_size_cpu"],
    )

    index = ProductIndex(
        embedding_dim=cfg["model"]["embedding_dim"],
        index_type=cfg["index"]["type"],
        nlist=cfg["index"]["nlist"],
        nprobe=cfg["index"]["nprobe"],
        index_path=cfg["index"]["index_path"],
        db_path=cfg["index"]["metadata_db"],
    )
    index.load()

    reranker = RerankerEngine(
        model_path=cfg["reranker"]["model_path"],
        embedding_dim=cfg["model"]["embedding_dim"],
    ) if cfg["reranker"]["enabled"] else None

    pipeline = SearchPipeline(
        embedder=embedder,
        index=index,
        reranker=reranker,
        top_k_candidates=cfg["retrieval"]["top_k_candidates"],
        top_k_final=cfg["retrieval"]["top_k_final"],
        cache_size=cfg["retrieval"]["cache_size"],
    )

    return pipeline


# ─── Header ──────────────────────────────────────────────────────────────────
st.markdown("# 🔍 Nova — Vision-Language Product Search")
st.markdown("*Search by text, image, or both. Powered by CLIP + FAISS + learned re-ranking.*")
st.divider()


# ─── Sidebar controls ────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("## ⚙️ Search Settings")

    top_k = st.slider("Results to show", 1, 10, 5)

    category = st.selectbox(
        "Product category",
        ["default", "dress", "shirt", "toptee", "shoes", "accessories"],
    )

    alpha = st.slider(
        "Fusion weight (α) — text ← | → image",
        min_value=0.0, max_value=1.0, value=0.5, step=0.05,
        help="Only applies to hybrid search. 1.0 = pure text, 0.0 = pure image."
    )

    use_adaptive = st.checkbox(
        "Auto-adjust α (adaptive fusion)",
        value=True,
        help="Overrides manual α slider. Uses query length to predict optimal weight."
    )

    st.divider()
    st.markdown("### About")
    st.markdown(
        "Nova uses CLIP ViT-B/32 to encode your query into a 512-dim "
        "embedding, retrieves the top-50 candidates from a FAISS index, "
        "then re-ranks with a learned cross-modal MLP."
    )


# ─── Query inputs ─────────────────────────────────────────────────────────────
col_text, col_img = st.columns([2, 1])

with col_text:
    text_query = st.text_input(
        "📝 Text query",
        placeholder="e.g. 'red floral summer dress with short sleeves'",
    )

with col_img:
    uploaded_file = st.file_uploader(
        "🖼️ Upload image",
        type=["jpg", "jpeg", "png", "webp"],
        help="Upload a product image to search by visual similarity",
    )

query_image: Optional[Image.Image] = None
if uploaded_file:
    query_image = Image.open(uploaded_file).convert("RGB")
    st.image(query_image, caption="Query image", width=200)


# ─── Search button ───────────────────────────────────────────────────────────
search_clicked = st.button("🔍 Search", type="primary", use_container_width=True)

if search_clicked:
    if not text_query and query_image is None:
        st.warning("Please enter a text query or upload an image.")
        st.stop()

    # Load pipeline
    try:
        pipeline = load_pipeline()
    except FileNotFoundError:
        st.error(
            "⚠️ Index not found. Please run `python scripts/build_index.py` first."
        )
        st.stop()

    # Run search
    with st.spinner("Searching..."):
        result = pipeline.search(
            text=text_query if text_query else None,
            image=query_image,
            category=category,
            alpha=None if use_adaptive else alpha,
            use_cache=True,
        )

    # ── Results header ────────────────────────────────────────────────────────
    st.divider()
    qtype_labels = {
        "text":   "📝 Text search",
        "image":  "🖼️ Image search",
        "hybrid": "🔀 Hybrid search",
    }
    header_col1, header_col2, header_col3 = st.columns(3)

    with header_col1:
        st.metric("Query type", qtype_labels[result["query_type"]])
    with header_col2:
        latency = result["latency_ms"]
        status_color = "normal" if latency < 200 else "inverse"
        st.metric("Latency", f"{latency:.1f} ms", delta="< 200ms target" if latency < 200 else "⚠ slow")
    with header_col3:
        hit = "✅ Cache hit" if result["cache_hit"] else "🔄 Live query"
        st.metric("Cache", hit)

    if result["query_type"] == "hybrid" and result["alpha"] is not None:
        st.info(f"Fusion α = **{result['alpha']:.2f}** "
                f"({'adaptive' if use_adaptive else 'manual'})")

    # ── Results grid ─────────────────────────────────────────────────────────
    st.markdown(f"### Top {len(result['results'])} Results")

    if not result["results"]:
        st.warning("No results found. Try a different query or rebuild the index.")
    else:
        cols = st.columns(min(5, len(result["results"])))

        for i, (col, item) in enumerate(zip(cols, result["results"])):
            with col:
                # Display product image
                img_path = item.get("image_path", "")
                if img_path and Path(img_path).exists():
                    try:
                        img = Image.open(img_path).convert("RGB")
                        st.image(img, use_column_width=True)
                    except Exception:
                        st.markdown("🖼️ *Image unavailable*")
                else:
                    st.markdown("🖼️ *Image unavailable*")

                score = item.get("rerank_score", item.get("score", 0.0))
                st.markdown(
                    f'<div class="result-card">'
                    f'<b>#{i+1}</b> — '
                    f'<span class="score-badge">{score:.3f}</span><br>'
                    f'<small>{item.get("product_id", "unknown")}</small><br>'
                    f'<small>Category: {item.get("category", "—")}</small>'
                    f'</div>',
                    unsafe_allow_html=True,
                )

    # ── Debug expander ────────────────────────────────────────────────────────
    with st.expander("🔧 Raw result data"):
        st.json(result["results"])
