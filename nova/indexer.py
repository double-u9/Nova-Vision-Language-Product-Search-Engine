"""
src/indexer.py
──────────────
FAISS-based vector index for high-speed approximate nearest neighbor (ANN)
search over product embeddings.

Index types supported:
  - Flat:    Exact brute-force (best for <10K items, ablation baseline)
  - IVFFlat: Inverted file index (100K–1M items)
  - IVFPQ:   IVF + Product Quantization (1M+ items, compressed)

Custom additions vs. vanilla FAISS usage:
  - Auto-selects index type based on corpus size
  - nprobe tuning for latency/recall tradeoff
  - Metadata side-table stored in SQLite alongside the index
"""

import os
import sqlite3
import logging
import json
from pathlib import Path
from typing import List, Dict, Tuple, Optional

import numpy as np
import faiss

logger = logging.getLogger(__name__)


class ProductIndex:
    """
    Manages the FAISS vector index and product metadata store.
    """

    # Thresholds for automatic index-type selection
    FLAT_MAX    = 10_000
    IVFFLAT_MAX = 500_000

    def __init__(
        self,
        embedding_dim: int = 512,
        index_type: str = "auto",         # "auto" | "Flat" | "IVFFlat" | "IVFPQ"
        nlist: int = 256,
        nprobe: int = 32,
        m: int = 64,                       # PQ sub-quantizers
        nbits: int = 8,
        index_path: str = "data/faiss.index",
        db_path: str = "data/products.db",
    ):
        self.embedding_dim = embedding_dim
        self.index_type    = index_type
        self.nlist         = nlist
        self.nprobe        = nprobe
        self.m             = m
        self.nbits         = nbits
        self.index_path    = Path(index_path)
        self.db_path       = Path(db_path)

        self.index: Optional[faiss.Index] = None
        self._id_map: List[str] = []   # FAISS int ID → product_id

        # Ensure directories exist
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._init_db()

    # ─── Database init ───────────────────────────────────────────────────────

    def _init_db(self):
        """Initialize SQLite metadata store."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS products (
                faiss_id    INTEGER PRIMARY KEY,
                product_id  TEXT NOT NULL,
                image_path  TEXT,
                category    TEXT,
                metadata    TEXT        -- JSON blob for extra fields
            )
        """)
        conn.commit()
        conn.close()

    # ─── Index construction ──────────────────────────────────────────────────

    def _build_index(self, n_vectors: int) -> faiss.Index:
        """
        Auto-select and construct appropriate FAISS index.

        All indices use inner-product metric (requires L2-normalized vectors
        so that IP == cosine similarity).
        """
        resolved = self.index_type
        if resolved == "auto":
            if n_vectors <= self.FLAT_MAX:
                resolved = "Flat"
            elif n_vectors <= self.IVFFLAT_MAX:
                resolved = "IVFFlat"
            else:
                resolved = "IVFPQ"

        logger.info(f"Building FAISS index type={resolved} for {n_vectors} vectors")

        if resolved == "Flat":
            index = faiss.IndexFlatIP(self.embedding_dim)

        elif resolved == "IVFFlat":
            quantizer = faiss.IndexFlatIP(self.embedding_dim)
            index = faiss.IndexIVFFlat(
                quantizer, self.embedding_dim, self.nlist, faiss.METRIC_INNER_PRODUCT
            )

        elif resolved == "IVFPQ":
            quantizer = faiss.IndexFlatIP(self.embedding_dim)
            index = faiss.IndexIVFPQ(
                quantizer, self.embedding_dim, self.nlist, self.m, self.nbits
            )

        else:
            raise ValueError(f"Unknown index type: {resolved}")

        return index

    def build(
        self,
        embeddings: np.ndarray,
        product_ids: List[str],
        image_paths: List[str],
        categories: Optional[List[str]] = None,
        metadata: Optional[List[Dict]] = None,
    ):
        """
        Build the FAISS index from scratch and populate the metadata DB.

        Args:
            embeddings:   (N, 512) float32, L2-normalized
            product_ids:  list of string product identifiers
            image_paths:  list of image file paths
            categories:   optional per-product category labels
            metadata:     optional list of dicts with extra product fields
        """
        assert embeddings.dtype == np.float32, "FAISS requires float32"
        n = len(embeddings)
        assert n == len(product_ids), "Mismatch between embeddings and product_ids"

        categories = categories or ["unknown"] * n
        metadata   = metadata or [{}] * n

        # Build index
        self.index = self._build_index(n)

        # Train if needed (IVF indices require a training phase)
        if hasattr(self.index, "train") and not isinstance(self.index, faiss.IndexFlat):
            logger.info("Training FAISS index (IVF/PQ)...")
            self.index.train(embeddings)

        # Set nprobe for IVF indices
        if hasattr(self.index, "nprobe"):
            self.index.nprobe = self.nprobe

        # Add vectors
        self.index.add(embeddings)
        self._id_map = list(product_ids)

        # Populate metadata DB
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM products")
        rows = [
            (i, product_ids[i], image_paths[i], categories[i], json.dumps(metadata[i]))
            for i in range(n)
        ]
        conn.executemany(
            "INSERT INTO products VALUES (?, ?, ?, ?, ?)", rows
        )
        conn.commit()
        conn.close()

        logger.info(f"Index built: {self.index.ntotal} vectors stored")

    def save(self):
        """Persist the FAISS index and id map to disk."""
        faiss.write_index(self.index, str(self.index_path))
        id_map_path = self.index_path.with_suffix(".ids.json")
        with open(id_map_path, "w") as f:
            json.dump(self._id_map, f)
        logger.info(f"Index saved to {self.index_path}")

    def load(self):
        """Load FAISS index and id map from disk."""
        if not self.index_path.exists():
            raise FileNotFoundError(f"Index not found at {self.index_path}")
        self.index = faiss.read_index(str(self.index_path))
        if hasattr(self.index, "nprobe"):
            self.index.nprobe = self.nprobe
        id_map_path = self.index_path.with_suffix(".ids.json")
        with open(id_map_path) as f:
            self._id_map = json.load(f)
        logger.info(f"Index loaded: {self.index.ntotal} vectors")

    # ─── Search ──────────────────────────────────────────────────────────────

    def search(
        self,
        query_emb: np.ndarray,
        top_k: int = 50,
    ) -> List[List[Dict]]:
        """
        Search the index for nearest neighbors.

        Args:
            query_emb: (Q, 512) float32, L2-normalized query embeddings
            top_k:     number of candidates to return per query

        Returns:
            List of Q lists, each containing top_k dicts:
              {"faiss_id": int, "product_id": str, "score": float,
               "image_path": str, "category": str, "metadata": dict}
        """
        if query_emb.ndim == 1:
            query_emb = query_emb[np.newaxis, :]

        scores, indices = self.index.search(query_emb, top_k)   # (Q, k)

        conn = sqlite3.connect(self.db_path)

        results = []
        for q_idx in range(len(query_emb)):
            q_results = []
            for rank, (faiss_id, score) in enumerate(zip(indices[q_idx], scores[q_idx])):
                if faiss_id == -1:
                    continue   # FAISS returns -1 for unfilled slots
                row = conn.execute(
                    "SELECT product_id, image_path, category, metadata "
                    "FROM products WHERE faiss_id = ?",
                    (int(faiss_id),)
                ).fetchone()
                if row:
                    product_id, image_path, category, meta_json = row
                    q_results.append({
                        "faiss_id":   int(faiss_id),
                        "product_id": product_id,
                        "score":      float(score),
                        "image_path": image_path,
                        "category":   category,
                        "metadata":   json.loads(meta_json),
                        "rank":       rank + 1,
                    })
            results.append(q_results)

        conn.close()
        return results

    def __len__(self):
        return self.index.ntotal if self.index else 0
