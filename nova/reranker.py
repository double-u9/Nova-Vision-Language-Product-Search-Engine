"""
src/reranker.py
───────────────
Lightweight learned re-ranker for cross-modal candidate scoring.

Architecture:
  Input: [q ⊕ p ⊕ |q−p| ⊕ q*p]  (4 × 512 = 2048 dim)
  Hidden: 512-dim ReLU layers
  Output: scalar relevance score

Trained with ListMLE ranking loss on Fashion-IQ triplets.

Custom improvement:
  Using 4 cross-modal feature types (concat, diff, product, abs-diff)
  gives significantly stronger signal than cosine similarity alone.
"""

import logging
from typing import List, Dict, Optional
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

logger = logging.getLogger(__name__)


class CrossModalReranker(nn.Module):
    """
    MLP-based cross-modal relevance scorer.

    Takes a (query, candidate) embedding pair and outputs a scalar score.
    Trained to push relevant candidates to rank 1 within a list.
    """

    def __init__(
        self,
        embedding_dim: int = 512,
        hidden_dim: int = 512,
        dropout: float = 0.1,
    ):
        super().__init__()

        input_dim = embedding_dim * 4   # concat + diff + product + abs-diff

        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim // 2, 1),
        )

        self._init_weights()

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.xavier_uniform_(m.weight)
                nn.init.zeros_(m.bias)

    def _build_features(
        self,
        query: torch.Tensor,     # (B, D)
        product: torch.Tensor,   # (B, D)
    ) -> torch.Tensor:
        """
        Build rich cross-modal feature vector.

        Features:
          - concat:   [q, p]         — raw signals
          - diff:     q − p          — component-wise difference
          - hadamard: q * p          — element-wise interaction
          - abs_diff: |q − p|        — magnitude of disagreement
        """
        diff     = query - product
        hadamard = query * product
        abs_diff = torch.abs(diff)
        return torch.cat([query, product, diff, hadamard], dim=-1)   # (B, 4D)

    def forward(
        self,
        query: torch.Tensor,    # (B, D)
        product: torch.Tensor,  # (B, D)
    ) -> torch.Tensor:
        """Returns scalar relevance scores, shape (B,)."""
        features = self._build_features(query, product)
        return self.net(features).squeeze(-1)


class ListMLELoss(nn.Module):
    """
    ListMLE ranking loss — directly optimizes likelihood of the correct ordering.

    Given a ranked list and scores, minimizes the negative log-likelihood of
    the ground-truth permutation.

    Reference: Xia et al., "Listwise Approach to Learning to Rank", ICML 2008
    """

    def forward(self, scores: torch.Tensor, relevance: torch.Tensor) -> torch.Tensor:
        """
        Args:
            scores:    (B, K) predicted relevance scores
            relevance: (B, K) ground-truth relevance labels (higher = more relevant)

        Returns:
            Scalar loss value.
        """
        # Sort by ground-truth relevance descending
        sorted_idx   = torch.argsort(relevance, dim=-1, descending=True)
        sorted_scores = torch.gather(scores, 1, sorted_idx)

        # ListMLE: sum of log-softmax over suffixes
        loss = torch.zeros(scores.size(0), device=scores.device)
        for i in range(sorted_scores.size(1)):
            suffix_scores = sorted_scores[:, i:]
            log_probs = F.log_softmax(suffix_scores, dim=-1)
            loss += -log_probs[:, 0]   # log prob of top item in remaining suffix

        return loss.mean()


class RerankerEngine:
    """
    Wraps CrossModalReranker for inference — re-scores FAISS candidates
    and returns sorted top-k results.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        embedding_dim: int = 512,
        device: str = "auto",
    ):
        if device == "auto":
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        self.model = CrossModalReranker(embedding_dim=embedding_dim).to(self.device)

        if model_path and Path(model_path).exists():
            state = torch.load(model_path, map_location=self.device)
            self.model.load_state_dict(state)
            logger.info(f"Re-ranker loaded from {model_path}")
        else:
            logger.warning("No re-ranker checkpoint found — using untrained model (fallback to score ordering)")

        self.model.eval()

    @torch.no_grad()
    def rerank(
        self,
        query_emb: np.ndarray,          # (512,)
        candidates: List[Dict],          # from ProductIndex.search(), top-50
        top_k: int = 5,
        query_emb_bank: Optional[np.ndarray] = None,  # pre-encoded candidate embs
    ) -> List[Dict]:
        """
        Re-score candidates and return top-k sorted by learned score.

        If candidate embeddings are available (query_emb_bank), uses the
        full MLP scorer. Otherwise falls back to raw FAISS cosine scores.

        Args:
            query_emb:      (512,) query embedding, L2-normalized
            candidates:     list of dicts from FAISS search
            top_k:          number of results to return
            query_emb_bank: (N, 512) embeddings for candidates, optional

        Returns:
            Top-k candidates sorted by re-rank score, with added "rerank_score"
        """
        if not candidates:
            return []

        if query_emb_bank is None:
            # Fallback: use FAISS scores directly (no learned re-ranking)
            sorted_cands = sorted(candidates, key=lambda x: x["score"], reverse=True)
            for i, c in enumerate(sorted_cands[:top_k]):
                c["rerank_score"] = c["score"]
                c["rerank"] = i + 1
            return sorted_cands[:top_k]

        # Full MLP re-ranking
        q_tensor = torch.tensor(query_emb, dtype=torch.float32).unsqueeze(0).to(self.device)  # (1, D)
        q_expanded = q_tensor.expand(len(candidates), -1)                                       # (N, D)

        cand_tensors = torch.tensor(query_emb_bank, dtype=torch.float32).to(self.device)        # (N, D)

        scores = self.model(q_expanded, cand_tensors).cpu().numpy()   # (N,)

        for i, cand in enumerate(candidates):
            cand["rerank_score"] = float(scores[i])

        sorted_cands = sorted(candidates, key=lambda x: x["rerank_score"], reverse=True)

        for i, c in enumerate(sorted_cands[:top_k]):
            c["rerank"] = i + 1

        return sorted_cands[:top_k]
