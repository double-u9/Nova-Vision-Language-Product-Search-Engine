# 🏗️ System Architecture — Vision-Language Product Search Engine

## Overview

This document describes the full production-grade architecture for a cross-modal
product retrieval system powered by CLIP (ViT-B/32) and FAISS, with custom
improvements in fusion weighting, learned re-ranking, and hard negative mining.

---

## 1. Full Data Flow Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OFFLINE PIPELINE                            │
│                                                                     │
│  Raw Data         Preprocessing        Embedding         Index      │
│  ─────────        ────────────         ─────────         ─────      │
│  Fashion-IQ  ──►  Clean / Resize  ──►  CLIP ViT-B/32 ──► FAISS    │
│  Images &         Normalize            Encode images     IVF-PQ     │
│  Captions         Filter corrupt       L2-normalize      index      │
│                   Augment (opt.)       Store vectors     + metadata │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         ONLINE PIPELINE                             │
│                                                                     │
│  Query           Encode             Retrieve          Re-Rank       │
│  ─────           ──────             ────────          ───────       │
│  Text   ──┐      CLIP Text  ──►                                     │
│           ├──►   Encoder           FAISS ANN  ──►    Bi-encoder    │
│  Image  ──┤      CLIP Image        top-50             cross-attn   │
│           │      Encoder           candidates         score → top5  │
│  Hybrid ──┘      Weighted                                           │
│                  Fusion                                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Breakdown

### 2.1 Data Ingestion
- Source: Fashion-IQ dataset (image + caption triplets)
- Loader: `src/data/loader.py` — streams from local disk or S3
- Metadata stored in SQLite / Parquet for fast lookup at retrieval time

### 2.2 Preprocessing
- Resize images to 224×224 (CLIP requirement)
- RGB normalization: mean=(0.481,0.458,0.408), std=(0.269,0.261,0.276)
- Filter corrupt / zero-dimension images
- Text: truncate to 77 tokens (CLIP limit), lower-case, strip HTML

### 2.3 Embedding Generation
- Model: `openai/clip-vit-b-32` via HuggingFace / official CLIP repo
- **Custom modification**: L2-normalization after projection head output
  before storing — ensures cosine similarity = dot product in FAISS
- Batched inference: batch_size=256 on GPU, 64 on CPU
- Output: 512-dim float32 vectors

### 2.4 FAISS Index
- Index type: `IndexIVFPQ` for scalable ANN search
  - `nlist=256` (cluster centroids)
  - `m=64` sub-quantizers, `nbits=8`
- Fallback for small datasets (<10K): `IndexFlatIP` (exact, fast enough)
- Index persisted to disk; reloaded on startup (< 1s for 10K items)

### 2.5 Query Processing
- **Text query**: tokenize → CLIP text encoder → L2-normalize → FAISS search
- **Image query**: preprocess → CLIP image encoder → L2-normalize → FAISS search
- **Hybrid query**: weighted fusion of text + image embeddings
  - `α * text_emb + (1−α) * image_emb` then re-normalize
  - α learned via a small MLP trained on validation triplets (default α=0.5)

### 2.6 Retrieval
- FAISS returns top-50 candidates with scores
- Metadata joined from SQLite to get product info

### 2.7 Re-Ranking Layer
- Lightweight cross-modal scorer:  
  `score(q, p) = MLP([q ⊕ p ⊕ |q−p| ⊕ q*p])`
- Input: 512×4 = 2048-dim; hidden: 512; output: scalar
- Trained with listwise ranking loss on Fashion-IQ triplets
- Re-scores top-50, returns top-5
- Adds ~15ms overhead; large Recall@5 gain

### 2.8 Caching
- LRU cache (128 entries) for frequently repeated queries
- MD5 hash of (query_text + image_bytes) as cache key

---

## 3. Advanced Improvements

### 3.1 Adaptive Hybrid Fusion (Custom)
**Motivation**: Fixed α=0.5 ignores query intent. A text-heavy query needs
more weight on language; an ambiguous image needs more on vision.
**Implementation**: Train a 2-layer MLP that takes [text_conf, image_conf, text_len]
as features to predict α dynamically per query.
**Impact**: +3–5% Recall@5 on hybrid queries vs fixed α.

### 3.2 Hard Negative Mining
**Motivation**: Random negatives in training are too easy; the model doesn't
learn fine-grained boundaries.
**Implementation**: After each epoch, embed all products, mine negatives that are
close in embedding space but labeled as non-matching. Use these in a custom
InfoNCE loss with hard negative temperature scaling.
**Impact**: Estimated +4–6% Recall@5 after fine-tuning.

### 3.3 Learned Re-Ranker
**Motivation**: FAISS ANN is fast but uses L2/dot-product only; a learned
model can capture cross-modal alignment signals.
**Implementation**: Lightweight 3-layer MLP re-ranker trained with
ListMLE / LambdaRank loss. Runs only on top-50 candidates.
**Impact**: +5–8% Recall@5, latency cost ~15ms.

### 3.4 Domain Adaptation via Prompt Engineering
**Motivation**: CLIP is trained on generic web data; fashion/product terms
may be under-represented.
**Implementation**: Prepend structured prompts:
  `"A photo of a {category} product: {description}"`
  Prompt templates selected per category from a lookup.
**Impact**: +2–3% zero-shot Recall@5 without any fine-tuning.

### 3.5 Embedding Normalization + Temperature Scaling
**Motivation**: Raw CLIP cosine similarities cluster near 1.0 for in-domain
data, compressing ranking signal.
**Implementation**: Apply L2-norm + learned temperature T (initialized=0.07)
as a post-processing calibration step.
**Impact**: Better score discrimination; faster FAISS convergence.

---

## 4. Ablation Study Design

| Experiment | Config | Hypothesis | Metric |
|---|---|---|---|
| A1 | Baseline CLIP flat search | Lower bound | Recall@5 |
| A2 | + FAISS IVF-PQ | Same recall, 10× faster | Recall@5, latency |
| A3 | + L2 normalization | +2–3% recall | Recall@5 |
| A4 | + Re-ranker | +5–8% recall | Recall@5 |
| A5 | + Hard negatives | +4–6% recall | Recall@5 |
| A6 | + Adaptive fusion | +3–5% hybrid recall | Recall@5 hybrid |
| A7 | Full system | Best overall | All metrics |

---

## 5. Evaluation Plan

- **Dataset split**: 70% train / 15% val / 15% test (stratified by category)
- **Data leakage prevention**: Split by product ID, not image ID
- **Metrics**:
  - Recall@5: fraction of queries where ground-truth in top-5
  - Recall@10: broader coverage metric
  - MRR (Mean Reciprocal Rank): rank quality
  - P95 latency: measured over 1000 random queries
- **Evaluation code**: `src/evaluation/metrics.py`

---

## 6. Scalability Plan

| Scale | Index Type | Hardware | Latency Target |
|---|---|---|---|
| 10K | IndexFlatIP | CPU | <50ms |
| 100K | IndexIVFFlat | CPU | <100ms |
| 1M | IndexIVFPQ | GPU | <200ms |
| 10M | Distributed FAISS | GPU cluster | <500ms |

- **GPU vs CPU**: GPU FAISS (`faiss-gpu`) gives 5–10× throughput for >1M items
- **Batch processing**: Offline embedding in batches of 256; async queue for online
- **Caching**: Redis-backed query cache; CDN caching for top-1000 queries
- **Horizontal scaling**: Embed servers stateless; FAISS index replicated per node
