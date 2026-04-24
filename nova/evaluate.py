"""scripts/evaluate.py — Run evaluation on held-out test set."""

import argparse
import logging
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.data.preprocessor import FashionIQLoader
from src.embedder import CLIPEmbedder
from src.indexer import ProductIndex
from src.pipeline import SearchPipeline
from src.reranker import RerankerEngine
from src.evaluation.metrics import evaluate_pipeline, benchmark_latency

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("evaluate")


def main(args):
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    # Load pipeline
    embedder = CLIPEmbedder(
        model_name=cfg["model"]["name"],
        device=cfg["model"]["device"],
    )
    index = ProductIndex(
        index_path=cfg["index"]["index_path"],
        db_path=cfg["index"]["metadata_db"],
    )
    index.load()

    reranker = RerankerEngine(
        model_path=cfg["reranker"]["model_path"],
    ) if cfg["reranker"]["enabled"] else None

    pipeline = SearchPipeline(
        embedder=embedder,
        index=index,
        reranker=reranker,
    )

    # Load test set
    loader = FashionIQLoader(data_root=args.data_root)
    test_df = loader.load_triplets(split=args.split)

    # Evaluation
    logger.info(f"Running evaluation on {args.split} split ({len(test_df)} queries)...")
    metrics = evaluate_pipeline(pipeline, test_df, recall_ks=cfg["evaluation"]["recall_ks"])

    # Latency benchmark
    logger.info("Running latency benchmark...")
    text_queries = [
        {"text": " and ".join(row["captions"]), "category": row.get("category", "default")}
        for _, row in test_df.iterrows()
    ]
    latency = benchmark_latency(
        pipeline,
        text_queries,
        warmup=cfg["evaluation"]["latency_warmup_queries"],
        n_eval=min(cfg["evaluation"]["latency_eval_queries"], len(text_queries)),
    )

    print("\n" + "=" * 50)
    print("EVALUATION RESULTS")
    print("=" * 50)
    for k, v in metrics.items():
        print(f"  {k:20s}: {v:.4f}")
    print(f"\n  {'p50_latency_ms':20s}: {latency['p50_ms']:.1f}")
    print(f"  {'p95_latency_ms':20s}: {latency['p95_ms']:.1f}")
    print(f"  {'p99_latency_ms':20s}: {latency['p99_ms']:.1f}")

    target_met = metrics.get("recall@5", 0) >= 0.60 and latency["p95_ms"] < 200
    print(f"\n  Target (Recall@5 > 0.60, P95 < 200ms): {'✅ MET' if target_met else '❌ NOT MET'}")
    print("=" * 50)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data_root", default="data/")
    parser.add_argument("--split",     default="test", choices=["train", "val", "test"])
    parser.add_argument("--config",    default="config.yaml")
    main(parser.parse_args())
