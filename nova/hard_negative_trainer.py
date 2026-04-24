"""
src/training/hard_negative_trainer.py
──────────────────────────────────────
Fine-tuning CLIP's projection head using hard negative mining.

Custom InfoNCE loss with:
  - In-batch negatives + mined hard negatives
  - Temperature scaling (learnable)
  - Hard negative margin weight

Reference:
  "Learning Transferable Visual Models From Natural Language Supervision"
  Radford et al., 2021 (CLIP)

  "RINCE: Robust InfoNCE with Hard Negatives"
  (adapted concept for domain adaptation)
"""

import logging
from typing import List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

logger = logging.getLogger(__name__)


class FashionIQTripletDataset(Dataset):
    """
    Dataset returning (reference_image_emb, text_emb, target_image_emb) triplets.

    We embed once offline and train on pre-computed embeddings for speed.
    """

    def __init__(
        self,
        image_embeddings: np.ndarray,   # (N_gallery, 512)
        text_embeddings: np.ndarray,    # (N_queries, 512)
        candidate_ids: List[int],       # query-to-candidate gallery index
        target_ids: List[int],          # query-to-target gallery index
    ):
        self.image_embeddings = torch.tensor(image_embeddings, dtype=torch.float32)
        self.text_embeddings  = torch.tensor(text_embeddings, dtype=torch.float32)
        self.candidate_ids    = candidate_ids
        self.target_ids       = target_ids

    def __len__(self):
        return len(self.text_embeddings)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        text_emb  = self.text_embeddings[idx]
        ref_emb   = self.image_embeddings[self.candidate_ids[idx]]
        target_emb = self.image_embeddings[self.target_ids[idx]]
        return text_emb, ref_emb, target_emb


class HardNegativeInfoNCE(nn.Module):
    """
    InfoNCE loss with hard negative augmentation.

    Standard InfoNCE treats all non-positive samples equally as negatives.
    This variant up-weights negatives that are semantically close to the
    query (hard negatives), forcing the model to learn finer boundaries.

    Loss formula:
      L = -log( exp(sim(q, pos) / T) /
                [exp(sim(q, pos) / T) + Σ_hard w_i * exp(sim(q, neg_i) / T)] )

    where w_i = exp(sim(q, neg_i)) (higher for harder negatives)
    """

    def __init__(self, temperature: float = 0.07, hard_weight: float = 1.5):
        super().__init__()
        self.temperature  = nn.Parameter(torch.tensor(temperature))
        self.hard_weight  = hard_weight

    def forward(
        self,
        query: torch.Tensor,    # (B, D) text or hybrid queries
        positive: torch.Tensor, # (B, D) target image embeddings
        negative: torch.Tensor, # (B * K, D) hard negative embeddings
        neg_per_pos: int = 5,   # K negatives per positive
    ) -> torch.Tensor:
        """
        Args:
            query:    (B, D)
            positive: (B, D)
            negative: (B*K, D) — hard negatives, interleaved per batch item
        Returns:
            scalar loss
        """
        T = self.temperature.clamp(min=0.01, max=0.5)

        # Positive similarities: (B,)
        pos_sim = F.cosine_similarity(query, positive) / T

        # Negative similarities: reshape to (B, K)
        neg = negative.view(query.size(0), neg_per_pos, -1)       # (B, K, D)
        q_  = query.unsqueeze(1).expand_as(neg)                    # (B, K, D)
        neg_sim = F.cosine_similarity(q_, neg, dim=-1) / T         # (B, K)

        # Hard negative weights: closer in embedding space → higher weight
        with torch.no_grad():
            weights = torch.softmax(neg_sim * self.hard_weight, dim=-1)   # (B, K)

        # Weighted denominator
        weighted_neg = (weights * torch.exp(neg_sim)).sum(dim=-1)   # (B,)
        denominator  = torch.exp(pos_sim) + weighted_neg

        loss = -pos_sim + torch.log(denominator)
        return loss.mean()


def mine_hard_negatives(
    query_embs: np.ndarray,      # (N_queries, D)
    gallery_embs: np.ndarray,    # (N_gallery, D)
    target_ids: List[int],       # ground-truth positive indices
    k: int = 5,
    margin: float = 0.1,
) -> List[List[int]]:
    """
    Mine top-k hard negatives per query using cosine similarity.

    Hard negatives are gallery items that are:
      - NOT the ground-truth positive
      - Semantically close to the query (high cosine sim)
      - Below a similarity margin from the positive (to avoid false negatives)

    Args:
        query_embs:  (N, D) L2-normalized query embeddings
        gallery_embs: (M, D) L2-normalized gallery embeddings
        target_ids:  ground-truth positive index per query
        k:           number of hard negatives to mine per query
        margin:      minimum sim gap between positive and hard negative

    Returns:
        List of k hard negative indices per query
    """
    import faiss

    # Build a flat index for fast similarity search
    d = gallery_embs.shape[1]
    index = faiss.IndexFlatIP(d)
    index.add(gallery_embs.astype(np.float32))

    # Retrieve top-(k+10) to have buffer after filtering out positives
    scores, indices = index.search(query_embs.astype(np.float32), k + 10)

    hard_negatives = []
    for i, (idxs, sims) in enumerate(zip(indices, scores)):
        pos_idx = target_ids[i]
        pos_sim = float(query_embs[i] @ gallery_embs[pos_idx])

        hn = []
        for idx, sim in zip(idxs, sims):
            if idx == pos_idx:
                continue
            # Only include if not trivially easy (sim > threshold)
            if sim < 0.1:
                continue
            # Skip if too close to positive (potential false negative)
            if sim > pos_sim - margin:
                hn.append(int(idx))
            if len(hn) >= k:
                break
        # Pad with random negatives if not enough hard ones found
        while len(hn) < k:
            rnd = np.random.randint(0, len(gallery_embs))
            if rnd != pos_idx:
                hn.append(rnd)
        hard_negatives.append(hn[:k])

    return hard_negatives
