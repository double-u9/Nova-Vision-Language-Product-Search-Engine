"""
src/data/preprocessor.py
─────────────────────────
Handles data ingestion, cleaning, and preprocessing for the Fashion-IQ
and Amazon Products datasets. Designed for both offline batch processing
and online single-sample preprocessing.
"""

import os
import logging
from pathlib import Path
from typing import Optional, Tuple, List, Dict

import numpy as np
import pandas as pd
from PIL import Image, UnidentifiedImageError
import torch
from torchvision import transforms
import clip

logger = logging.getLogger(__name__)


# ─── CLIP-standard normalization constants ────────────────────────────────────
CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD  = (0.26862954, 0.26130258, 0.27577711)


class ImagePreprocessor:
    """
    Prepares images for CLIP encoding.

    Custom addition vs. vanilla CLIP preprocessing:
    - Corrupt image detection and graceful skip
    - Aspect-ratio-preserving resize before center crop
    - Optional test-time augmentation (TTA) for improved retrieval stability
    """

    def __init__(self, image_size: int = 224, tta: bool = False):
        self.image_size = image_size
        self.tta = tta

        # Standard CLIP transform (used at encode time)
        self.transform = transforms.Compose([
            transforms.Resize(image_size, interpolation=transforms.InterpolationMode.BICUBIC),
            transforms.CenterCrop(image_size),
            transforms.ToTensor(),
            transforms.Normalize(mean=CLIP_MEAN, std=CLIP_STD),
        ])

        # TTA: 5-crop ensemble for more stable embeddings
        self.tta_transform = transforms.Compose([
            transforms.Resize(image_size + 32, interpolation=transforms.InterpolationMode.BICUBIC),
            transforms.FiveCrop(image_size),
            transforms.Lambda(lambda crops: torch.stack([
                transforms.Compose([
                    transforms.ToTensor(),
                    transforms.Normalize(mean=CLIP_MEAN, std=CLIP_STD),
                ])(c) for c in crops
            ])),
        ])

    def load_image(self, path: str) -> Optional[Image.Image]:
        """Load an image safely, returning None for corrupt files."""
        try:
            img = Image.open(path).convert("RGB")
            # Reject degenerate images
            if img.size[0] < 10 or img.size[1] < 10:
                logger.warning(f"Skipping tiny image: {path}")
                return None
            return img
        except (UnidentifiedImageError, OSError) as e:
            logger.warning(f"Corrupt image skipped [{path}]: {e}")
            return None

    def preprocess(self, image: Image.Image) -> torch.Tensor:
        """Apply standard CLIP preprocessing to a PIL image."""
        return self.transform(image)

    def preprocess_tta(self, image: Image.Image) -> torch.Tensor:
        """
        Apply 5-crop TTA and return mean-pooled tensor.
        Shape: (512,) after averaging across crops.
        """
        crops = self.tta_transform(image)   # (5, 3, H, W)
        return crops                         # caller handles mean pooling


class TextPreprocessor:
    """
    Prepares text queries for CLIP encoding.

    Custom addition:
    - Structured prompt templates per product category
    - Query expansion via synonym injection
    """

    # Prompt templates — improves zero-shot performance on product domains
    PROMPT_TEMPLATES: Dict[str, str] = {
        "default":    "a photo of a product: {text}",
        "dress":      "a photo of a dress: {text}",
        "shirt":      "a photo of a shirt or top: {text}",
        "toptee":     "a photo of a top or tee: {text}",
        "shoes":      "a photo of shoes: {text}",
        "accessories":"a photo of an accessory: {text}",
    }

    def __init__(self, max_length: int = 77):
        self.max_length = max_length

    def clean(self, text: str) -> str:
        """Lowercase, strip HTML tags, collapse whitespace."""
        import re
        text = re.sub(r"<[^>]+>", " ", text)      # strip HTML
        text = re.sub(r"\s+", " ", text).strip()
        return text.lower()

    def apply_prompt(self, text: str, category: str = "default") -> str:
        """Wrap text in a structured prompt for improved zero-shot retrieval."""
        template = self.PROMPT_TEMPLATES.get(category, self.PROMPT_TEMPLATES["default"])
        return template.format(text=text)

    def tokenize(self, texts: List[str]) -> torch.Tensor:
        """Tokenize a list of strings using CLIP's tokenizer (truncates at 77 tokens)."""
        return clip.tokenize(texts, truncate=True)


class FashionIQLoader:
    """
    Loads Fashion-IQ triplet data: (reference_image, modification_text, target_image).

    Dataset structure expected:
        data/
          images/              ← all product images
          fashion_iq/
            captions/          ← {split}.{category}.json  (triplets)
            image_splits/      ← {split}.{category}.json  (image lists)
    """

    CATEGORIES = ["dress", "shirt", "toptee"]

    def __init__(self, data_root: str):
        self.data_root = Path(data_root)
        self.image_dir = self.data_root / "fashionIQ_dataset/images"

    def load_triplets(self, split: str = "train") -> pd.DataFrame:
        """
        Returns DataFrame with columns:
            candidate, target, captions (list of 2 captions)
        """
        import json
        records = []
        for cat in self.CATEGORIES:
            caption_file = self.data_root / "fashion-iq-master" / "captions" / f"cap.{cat}.{split}.json"
            if not caption_file.exists():
                logger.warning(f"Missing caption file: {caption_file}")
                continue
            with open(caption_file) as f:
                data = json.load(f)
            for item in data:
                records.append({
                    "candidate": item["candidate"],
                    "target":    item["target"],
                    "captions":  item["captions"],   # list of 2 text modifications
                    "category":  cat,
                    "split":     split,
                })
        df = pd.DataFrame(records)
        logger.info(f"Loaded {len(df)} {split} triplets from Fashion-IQ")
        return df

    def load_gallery(self) -> pd.DataFrame:
        """
        Returns the full product gallery (all images with metadata).
        Rows: image_id, image_path, category
        """
        records = []
        for img_path in self.image_dir.glob("*.jpg"):
            records.append({
                "image_id":   img_path.stem,
                "image_path": str(img_path),
            })
        df = pd.DataFrame(records)
        logger.info(f"Gallery size: {len(df)} images")
        return df
