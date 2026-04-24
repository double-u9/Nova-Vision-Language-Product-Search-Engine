"""
src/evaluation/metrics.py
─────────────────────────
Evaluation utilities for retrieval systems.

Metrics implemented:
  - Recall@K     (primary metric — target Recall@5 > 0.60)
  - MRR          (Mean Reciprocal Rank)
  - NDCG@K       (Normalized Discounted Cumulative Gain)
  - Latency P50/P95/P99

Ablation harness included at bottom.
"""

import time
import logging
from typing import List, Dict, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# ─── Retrieval metrics ────────────────────────────────────────────────────────

def recall_at_k(
    retrieved: List[List[str]],    # list of retrieved product_id lists per query
    relevant: List[List[str]],     # list of ground-truth product_id lists per query
    k: int = 5,
) -> float:
    """
    Recall@K: fraction of queries where at least one relevant item is in top-K.

    For Fashion-IQ: each query has 1 relevant target image.
    """
    hits = 0
    for ret, rel in zip(retrieved, relevant):
        if any(r in set(rel) for r in ret[:k]):
            hits += 1
    return hits / len(retrieved) if retrieved else 0.0


def mean_reciprocal_rank(
    retrieved: List[List[str]],
    relevant: List[List[str]],
) -> float:
    """
    MRR: average of 1/rank of first relevant item across queries.
    """
    reciprocal_ranks = []
    for ret, rel in zip(retrieved, relevant):
        rel_set = set(rel)
        for rank, item in enumerate(ret, start=1):
            if item in rel_set:
                reciprocal_ranks.append(1.0 / rank)
                break
        else:
            reciprocal_ranks.append(0.0)
    return float(np.mean(reciprocal_ranks))


def ndcg_at_k(
    retrieved: List[List[str]],
    relevant: List[List[str]],
    k: int = 5,
) -> float:
    """
    NDCG@K: measures rank quality weighted by position.
    Binary relevance (1 if in ground truth, 0 otherwise).
    """
    def dcg(hits, k):
        return sum(
            h / np.log2(i + 2)
            for i, h in enumerate(hits[:k])
        )

    scores = []
    for ret, rel in zip(retrieved, relevant):
        rel_set = set(rel)
        hits = [1 if item in rel_set else 0 for item in ret[:k]]
        ideal_hits = sorted(hits, reverse=True)
        d = dcg(hits, k)
        id_ = dcg(ideal_hits, k)
        scores.append(d / id_ if id_ > 0 else 0.0)
    return float(np.mean(scores))


# ─── Latency benchmarking ─────────────────────────────────────────────────────

def benchmark_latency(
    pipeline,
    queries: List[Dict],
    warmup: int = 50,
    n_eval: int = 1000,
) -> Dict[str, float]:
    """
    Benchmark end-to-end query latency.

    Args:
        pipeline: SearchPipeline instance
        queries:  list of dicts with "text" and/or "image" keys
        warmup:   number of warmup queries (excluded from stats)
        n_eval:   number of queries to time

    Returns:
        dict with p50_ms, p95_ms, p99_ms, mean_ms, min_ms, max_ms
    """
    logger.info(f"Warming up with {warmup} queries...")
    for q in queries[:warmup]:
        pipeline.search(**q, use_cache=False)

    logger.info(f"Timing {n_eval} queries...")
    latencies = []
    for q in queries[:n_eval]:
        t0 = time.perf_counter()
        pipeline.search(**q, use_cache=False)
        latencies.append((time.perf_counter() - t0) * 1000)

    latencies = np.array(latencies)
    return {
        "p50_ms":  float(np.percentile(latencies, 50)),
        "p95_ms":  float(np.percentile(latencies, 95)),
        "p99_ms":  float(np.percentile(latencies, 99)),
        "mean_ms": float(np.mean(latencies)),
        "min_ms":  float(np.min(latencies)),
        "max_ms":  float(np.max(latencies)),
    }


# ─── Full evaluation run ──────────────────────────────────────────────────────

def evaluate_pipeline(
    pipeline,
    test_triplets: pd.DataFrame,
    recall_ks: List[int] = [1, 5, 10],
) -> Dict[str, float]:
    """
    End-to-end evaluation on a test set of (query_text, target_image_id) pairs.

    Args:
        pipeline:      SearchPipeline
        test_triplets: DataFrame with columns [captions, target, candidate, category]
        recall_ks:     list of K values for Recall@K

    Returns:
        dict of metric_name → value
    """
    retrieved_ids: List[List[str]] = []
    relevant_ids:  List[List[str]] = []

    logger.info(f"Evaluating on {len(test_triplets)} test queries...")

    for _, row in test_triplets.iterrows():
        # Combine both Fashion-IQ captions into one query
        query_text = " and ".join(row["captions"])
        result = pipeline.search(
            text=query_text,
            category=row.get("category", "default"),
            use_cache=False,
        )
        ret_ids = [r["product_id"] for r in result["results"]]
        retrieved_ids.append(ret_ids)
        relevant_ids.append([row["target"]])

    metrics = {}
    for k in recall_ks:
        metrics[f"recall@{k}"] = recall_at_k(retrieved_ids, relevant_ids, k=k)
        metrics[f"ndcg@{k}"]   = ndcg_at_k(retrieved_ids, relevant_ids, k=k)

    metrics["mrr"] = mean_reciprocal_rank(retrieved_ids, relevant_ids)

    logger.info("Evaluation results:")
    for k, v in metrics.items():
        logger.info(f"  {k}: {v:.4f}")

    return metrics


# ─── Ablation study harness ──────────────────────────────────────────────────

class AblationStudy:
    """
    Runs structured ablation experiments and logs results to a DataFrame.

    Experiments defined in ABLATION_CONFIGS are run in sequence.
    Results are saved to ablation_results.csv.
    """

    ABLATION_CONFIGS = [
        {
            "name": "A1_baseline_flat",
            "description": "CLIP + IndexFlatIP, no normalization, no re-ranking",
            "index_type": "Flat",
            "normalize": False,
            "reranker": False,
            "tta": False,
        },
        {
            "name": "A2_faiss_ivf",
            "description": "Add IVFFlat index (speed test)",
            "index_type": "IVFFlat",
            "normalize": True,
            "reranker": False,
            "tta": False,
        },
        {
            "name": "A3_normalization",
            "description": "Add L2 normalization",
            "index_type": "Flat",
            "normalize": True,
            "reranker": False,
            "tta": False,
        },
        {
            "name": "A4_reranker",
            "description": "Add learned MLP re-ranker",
            "index_type": "IVFFlat",
            "normalize": True,
            "reranker": True,
            "tta": False,
        },
        {
            "name": "A5_tta",
            "description": "Add test-time augmentation",
            "index_type": "IVFFlat",
            "normalize": True,
            "reranker": True,
            "tta": True,
        },
        {
            "name": "A6_full_system",
            "description": "Full system: IVFFlat + norm + re-ranker + TTA + adaptive fusion",
            "index_type": "IVFFlat",
            "normalize": True,
            "reranker": True,
            "tta": True,
            "adaptive_fusion": True,
        },
    ]

    def run(self, build_pipeline_fn, test_triplets: pd.DataFrame) -> pd.DataFrame:
        """
        Run all ablation configs and return a comparison DataFrame.

        Args:
            build_pipeline_fn: callable(config) → SearchPipeline
            test_triplets:     held-out test set

        Returns:
            DataFrame with columns: name, description, recall@5, recall@10, mrr, p95_ms
        """
        rows = []
        for cfg in self.ABLATION_CONFIGS:
            logger.info(f"\n{'='*50}")
            logger.info(f"Running ablation: {cfg['name']}")
            logger.info(f"Config: {cfg['description']}")

            pipeline = build_pipeline_fn(cfg)
            metrics  = evaluate_pipeline(pipeline, test_triplets)

            rows.append({
                "name":        cfg["name"],
                "description": cfg["description"],
                **metrics,
            })

        df = pd.DataFrame(rows)
        df.to_csv("ablation_results.csv", index=False)
        logger.info("\nAblation study complete. Results saved to ablation_results.csv")
        return df
