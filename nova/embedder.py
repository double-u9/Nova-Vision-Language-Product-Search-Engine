"""
src/embedder.py
───────────────
CLIP-based embedding engine with:
 - Batched GPU/CPU inference
 - L2-normalization (custom improvement)
 - Test-time augmentation (TTA) mode
 - Temperature-scaled similarity
"""

import logging
from typing import List, Optional, Union

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
import clip

from preprocessor import ImagePreprocessor, TextPreprocessor

logger = logging.getLogger(__name__)


class CLIPEmbedder:
    """
    Wraps OpenAI CLIP for product image and text embedding.

    Custom improvements over vanilla CLIP usage:
    1. L2-normalization: guarantees cosine similarity == dot product,
       enabling inner-product FAISS indices (IndexFlatIP / IVF).
    2. Temperature scaling: learned scalar T calibrates similarity scores
       for better downstream ranking discrimination.
    3. Batched inference: handles large galleries efficiently.
    4. TTA: optional 5-crop mean pooling for more stable image embeddings.
    """

    def __init__(
        self,
        model_name: str = "ViT-B/32",
        device: str = "auto",
        temperature: float = 0.07,
        batch_size: int = 256,
        tta: bool = False,
    ):
        # ── Device resolution ────────────────────────────────────────────────
        if device == "auto":
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        logger.info(f"Loading CLIP {model_name} on {self.device}")
        self.model, _ = clip.load(model_name, device=self.device)
        self.model.eval()

        # ── Custom temperature parameter (learnable during fine-tune) ────────
        self.log_temperature = torch.nn.Parameter(
            torch.tensor(np.log(1.0 / temperature), dtype=torch.float32)
        )

        self.batch_size = batch_size
        self.embedding_dim = 512   # ViT-B/32 projection dim

        self.image_proc = ImagePreprocessor(image_size=224, tta=tta)
        self.text_proc  = TextPreprocessor()
        self.tta        = tta

    # ─── Image embedding ─────────────────────────────────────────────────────

    @torch.no_grad()
    def encode_images(
        self,
        images: List[Union[str, Image.Image]],
        normalize: bool = True,
    ) -> np.ndarray:
        """
        Encode a list of image paths or PIL Images.

        Args:
            images:    list of file paths (str) or PIL Image objects
            normalize: apply L2-normalization (strongly recommended)

        Returns:
            np.ndarray of shape (N, 512)
        """
        all_embeddings = []

        for batch_start in range(0, len(images), self.batch_size):
            batch = images[batch_start : batch_start + self.batch_size]
            tensors = []

            for img in batch:
                # Load from path if needed
                if isinstance(img, str):
                    pil = self.image_proc.load_image(img)
                    if pil is None:
                        # Placeholder zero embedding for corrupt images
                        tensors.append(torch.zeros(3, 224, 224))
                        continue
                else:
                    pil = img

                if self.tta:
                    crops = self.image_proc.preprocess_tta(pil)   # (5, 3, 224, 224)
                    # Encode all 5 crops and average
                    crops = crops.to(self.device)
                    embs  = self.model.encode_image(crops)          # (5, 512)
                    emb   = embs.mean(dim=0)                        # (512,)
                    all_embeddings.append(emb.cpu())
                    continue
                else:
                    tensors.append(self.image_proc.preprocess(pil))

            if tensors:
                batch_tensor = torch.stack(tensors).to(self.device)  # (B, 3, 224, 224)
                embeddings = self.model.encode_image(batch_tensor)    # (B, 512)
                all_embeddings.extend(embeddings.cpu())

        if not all_embeddings:
            return np.zeros((0, self.embedding_dim), dtype=np.float32)

        result = torch.stack(all_embeddings).float().numpy()          # (N, 512)

        if normalize:
            result = self._l2_normalize(result)

        return result

    # ─── Text embedding ──────────────────────────────────────────────────────

    @torch.no_grad()
    def encode_texts(
        self,
        texts: List[str],
        category: str = "default",
        normalize: bool = True,
    ) -> np.ndarray:
        """
        Encode a list of text strings with structured prompt wrapping.

        Args:
            texts:    raw query strings
            category: product category for prompt template selection
            normalize: apply L2-normalization

        Returns:
            np.ndarray of shape (N, 512)
        """
        # Apply prompt template (domain adaptation improvement)
        prompted = [self.text_proc.apply_prompt(self.text_proc.clean(t), category) for t in texts]

        all_embeddings = []

        for batch_start in range(0, len(prompted), self.batch_size):
            batch = prompted[batch_start : batch_start + self.batch_size]
            tokens = self.text_proc.tokenize(batch).to(self.device)
            embeddings = self.model.encode_text(tokens)               # (B, 512)
            all_embeddings.extend(embeddings.cpu())

        result = torch.stack(all_embeddings).float().numpy()          # (N, 512)

        if normalize:
            result = self._l2_normalize(result)

        return result

    # ─── Hybrid fusion ───────────────────────────────────────────────────────

    def fuse_embeddings(
        self,
        text_emb: np.ndarray,
        image_emb: np.ndarray,
        alpha: float = 0.5,
    ) -> np.ndarray:
        """
        Weighted fusion of text and image embeddings.

        Formula: h = L2_norm(α * text_emb + (1−α) * image_emb)

        Args:
            text_emb:  shape (512,) or (N, 512)
            image_emb: shape (512,) or (N, 512)
            alpha:     weight for text (0=image only, 1=text only)

        Returns:
            Fused embedding, L2-normalized, same shape as inputs.
        """
        fused = alpha * text_emb + (1.0 - alpha) * image_emb
        return self._l2_normalize(fused)

    # ─── Utilities ───────────────────────────────────────────────────────────

    @staticmethod
    def _l2_normalize(x: np.ndarray) -> np.ndarray:
        """L2-normalize along last axis. Safe against zero-vectors."""
        norms = np.linalg.norm(x, axis=-1, keepdims=True)
        norms = np.maximum(norms, 1e-8)   # avoid divide by zero
        return x / norms

    def similarity(self, q: np.ndarray, k: np.ndarray) -> np.ndarray:
        """
        Temperature-scaled cosine similarity.
        Assumes both inputs are already L2-normalized.

        Returns scores in same shape as numpy dot(q, k.T).
        """
        T = float(torch.exp(self.log_temperature).item())
        return (q @ k.T) * T
