"""
src/pipeline.py
───────────────
End-to-end retrieval pipeline.

Handles:
  - Text queries
  - Image queries
  - Hybrid (text + image) queries

With optional:
  - LRU query caching
  - Adaptive α fusion (replaces fixed 0.5 weight)
  - Learned re-ranking

This is the single entry point for the Streamlit UI and any API layer.
"""

import hashlib
import logging
import time
from functools import lru_cache
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
from PIL import Image

from embedder import CLIPEmbedder
from indexer import ProductIndex
from reranker import RerankerEngine

logger = logging.getLogger(__name__)


class AdaptiveFusionMLP:
    """
    Lightweight α predictor.

    Predicts optimal text/image fusion weight based on:
      - text embedding confidence (max cosine sim in gallery)
      - image embedding confidence
      - text token length

    For production: replace with a 3-layer MLP trained on val triplets.
    For zero-shot default: uses heuristic based on token length.
    """

    def predict_alpha(
        self,
        text: Optional[str],
        has_image: bool,
    ) -> float:
        """
        Heuristic α: longer text → more text weight.
        Range clamped to [0.3, 0.7] to prevent degenerate fusion.
        """
        if text is None:
            return 0.0    # pure image query
        if not has_image:
            return 1.0    # pure text query

        word_count = len(text.split())
        # Short texts (<3 words): lean on image; longer texts: lean on text
        alpha = 0.3 + min(word_count / 20.0, 0.4)
        return float(np.clip(alpha, 0.3, 0.7))


class SearchPipeline:
    """
    Production-grade search pipeline with caching and multi-modal support.
    """

    def __init__(
        self,
        embedder: CLIPEmbedder,
        index: ProductIndex,
        reranker: Optional[RerankerEngine] = None,
        top_k_candidates: int = 50,
        top_k_final: int = 5,
        use_adaptive_fusion: bool = True,
        cache_size: int = 128,
    ):
        self.embedder          = embedder
        self.index             = index
        self.reranker          = reranker
        self.top_k_candidates  = top_k_candidates
        self.top_k_final       = top_k_final
        self.fusion_mlp        = AdaptiveFusionMLP() if use_adaptive_fusion else None
        self.cache_size        = cache_size

        # Simple in-process LRU cache
        self._cache: Dict[str, Dict[str, object]] = {}
        self._cache_order: List[str] = []

    # ─── Cache helpers ───────────────────────────────────────────────────────

    def _make_cache_key(
        self,
        text: Optional[str],
        image_bytes: Optional[bytes],
        category: str,
        alpha: Optional[float],
        top_k: int,
    ) -> str:
        h = hashlib.md5()
        if text:
            h.update(text.encode())
        if image_bytes:
            h.update(image_bytes[:4096])   # hash first 4KB of image for speed
        h.update(category.encode())
        h.update(str(alpha if alpha is not None else "auto").encode())
        h.update(str(top_k).encode())
        return h.hexdigest()

    def _cache_get(self, key: str) -> Optional[Dict[str, object]]:
        return self._cache.get(key)

    def _cache_put(self, key: str, value: Dict[str, object]):
        if key in self._cache:
            self._cache_order = [existing for existing in self._cache_order if existing != key]
        if len(self._cache) >= self.cache_size:
            oldest = self._cache_order.pop(0)
            self._cache.pop(oldest, None)
        self._cache[key] = value
        self._cache_order.append(key)

    # ─── Public search interface ─────────────────────────────────────────────

    def search(
        self,
        text: Optional[str] = None,
        image: Optional[Union[str, Image.Image]] = None,
        category: str = "default",
        alpha: Optional[float] = None,
        top_k: Optional[int] = None,
        use_cache: bool = True,
    ) -> Dict:
        """
        Unified search entrypoint for text, image, and hybrid queries.

        Args:
            text:      query string (None for image-only)
            image:     PIL Image or path (None for text-only)
            category:  product category for prompt template
            alpha:     override fusion weight (auto-predicted if None)
            use_cache: enable query result caching

        Returns:
            dict with keys:
              results:     list of top-k product dicts
              query_type:  "text" | "image" | "hybrid"
              latency_ms:  end-to-end query latency
              alpha:       fusion weight used (hybrid only)
        """
        t0 = time.perf_counter()

        if text is None and image is None:
            raise ValueError("At least one of text or image must be provided")

        # Determine query type
        if text is not None and image is not None:
            query_type = "hybrid"
        elif text is not None:
            query_type = "text"
        else:
            query_type = "image"

        requested_top_k = max(1, top_k or self.top_k_final)

        # Cache key (image → bytes hash if PIL)
        image_bytes = None
        if image is not None and isinstance(image, Image.Image):
            import io
            buf = io.BytesIO()
            image.save(buf, format="JPEG")
            image_bytes = buf.getvalue()

        cache_key = self._make_cache_key(
            text,
            image_bytes,
            category,
            alpha,
            requested_top_k,
        )
        if use_cache:
            cached = self._cache_get(cache_key)
            if cached is not None:
                latency = (time.perf_counter() - t0) * 1000
                return {
                    "results": cached["results"],
                    "query_type": query_type,
                    "latency_ms": latency,
                    "cache_hit": True,
                    "alpha": cached.get("alpha"),
                }

        # ── Embed query ───────────────────────────────────────────────────────
        query_emb = self._embed_query(text, image, category, alpha, query_type)
        used_alpha = alpha

        if query_type == "hybrid" and alpha is None and self.fusion_mlp:
            used_alpha = self.fusion_mlp.predict_alpha(text, has_image=True)
            query_emb  = self._embed_query(text, image, category, used_alpha, query_type)

        # ── FAISS retrieval ───────────────────────────────────────────────────
        candidate_top_k = max(self.top_k_candidates, requested_top_k)
        raw_results = self.index.search(query_emb, top_k=candidate_top_k)[0]

        # ── Re-ranking ────────────────────────────────────────────────────────
        if self.reranker is not None and raw_results:
            final_results = self.reranker.rerank(
                query_emb=query_emb.squeeze(),
                candidates=raw_results,
                top_k=requested_top_k,
            )
        else:
            final_results = raw_results[:requested_top_k]
            for i, r in enumerate(final_results):
                r["rerank"] = i + 1

        latency = (time.perf_counter() - t0) * 1000

        # Cache result
        if use_cache:
            self._cache_put(cache_key, {"results": final_results, "alpha": used_alpha})

        logger.info(
            f"[{query_type}] query completed in {latency:.1f}ms — "
            f"{len(final_results)} results returned"
        )

        return {
            "results":    final_results,
            "query_type": query_type,
            "latency_ms": latency,
            "cache_hit":  False,
            "alpha":      used_alpha,
        }

    # ─── Internal embedding helper ────────────────────────────────────────────

    def _embed_query(
        self,
        text: Optional[str],
        image: Optional[Union[str, Image.Image]],
        category: str,
        alpha: Optional[float],
        query_type: str,
    ) -> np.ndarray:
        """Embed query and fuse if hybrid."""

        if query_type == "text":
            return self.embedder.encode_texts([text], category=category)  # (1, 512)

        elif query_type == "image":
            return self.embedder.encode_images([image])                    # (1, 512)

        else:   # hybrid
            text_emb  = self.embedder.encode_texts([text], category=category)[0]   # (512,)
            image_emb = self.embedder.encode_images([image])[0]                     # (512,)
            a = alpha if alpha is not None else 0.5
            fused = self.embedder.fuse_embeddings(text_emb, image_emb, alpha=a)    # (512,)
            return fused[np.newaxis, :]                                             # (1, 512)
