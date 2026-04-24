"""
scripts/build_index.py
──────────────────────
Offline script to embed the product gallery and build the FAISS index.

Usage:
  python scripts/build_index.py \
    --data_root data/ \
    --index_path data/faiss.index \
    --batch_size 256
"""

import argparse
import logging
import sys
from pathlib import Path

import numpy as np
import yaml

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from preprocessor import FashionIQLoader
from embedder import CLIPEmbedder
from indexer import ProductIndex

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("build_index")


def main(args):
    # Load config
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    # ── Load gallery ──────────────────────────────────────────────────────────
    loader  = FashionIQLoader(data_root=args.data_root)
    gallery = loader.load_gallery()
    logger.info(f"Gallery: {len(gallery)} products")

    if len(gallery) == 0:
        logger.error("No images found. Check --data_root path.")
        sys.exit(1)

    # ── Embed gallery ─────────────────────────────────────────────────────────
    embedder = CLIPEmbedder(
        model_name=cfg["model"]["name"],
        device=cfg["model"]["device"],
        batch_size=args.batch_size,
    )

    logger.info("Encoding gallery images...")
    image_paths = gallery["image_path"].tolist()
    embeddings  = embedder.encode_images(image_paths, normalize=True)

    logger.info(f"Embeddings shape: {embeddings.shape}, dtype: {embeddings.dtype}")

    # ── Build FAISS index ─────────────────────────────────────────────────────
    index = ProductIndex(
        embedding_dim=cfg["model"]["embedding_dim"],
        index_type=cfg["index"]["type"],
        nlist=cfg["index"]["nlist"],
        nprobe=cfg["index"]["nprobe"],
        m=cfg["index"]["m"],
        nbits=cfg["index"]["nbits"],
        index_path=args.index_path,
        db_path=cfg["index"]["metadata_db"],
    )

    index.build(
        embeddings=embeddings,
        product_ids=gallery["image_id"].tolist(),
        image_paths=image_paths,
        categories=gallery.get("category", ["unknown"] * len(gallery)),
    )

    index.save()
    logger.info("✅ Index build complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build FAISS product index")
    parser.add_argument("--data_root",  default="data/",            help="Root data directory")
    parser.add_argument("--index_path", default="data/faiss.index", help="Output index path")
    parser.add_argument("--config",     default="config.yaml",      help="Config YAML path")
    parser.add_argument("--batch_size", type=int, default=256,       help="Embedding batch size")
    main(parser.parse_args())
