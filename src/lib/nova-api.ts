const API_BASE = (
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:5000"
).replace(/\/$/, "");

async function readJsonOrThrow<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${fallbackMessage}: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export type ProductResult = {
  product_id: string;
  image_path: string;
  category: string;
  score: number;
  rank: number;
};

export type SearchResponse = {
  results: ProductResult[];
  query_type: "text" | "image" | "hybrid" | "similar";
  latency_ms: number;
  cache_hit: boolean;
  alpha?: number | null;
};

export type HealthResponse = {
  status: string;
  index_size: number;
  requests_served: number;
  avg_latency_ms: number;
  startup_error?: string | null;
};

export function imageUrl(imagePath: string): string {
  const file = imagePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return `${API_BASE}/images/${file}`;
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE}/health`);
  return readJsonOrThrow<HealthResponse>(response, "health check failed");
}

export async function searchText(
  query: string,
  topK = 24,
  refresh = false,
  latencyTarget = 300,
): Promise<SearchResponse> {
  const response = await fetch(`${API_BASE}/search/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      top_k: topK,
      refresh,
      latency_target: latencyTarget,
    }),
  });
  return readJsonOrThrow<SearchResponse>(response, "text search failed");
}

export async function searchImage(
  file: File,
  topK = 24,
  refresh = false,
  latencyTarget = 300,
): Promise<SearchResponse> {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("top_k", String(topK));
  formData.append("refresh", String(refresh));
  formData.append("latency_target", String(latencyTarget));

  const response = await fetch(`${API_BASE}/search/image`, {
    method: "POST",
    body: formData,
  });

  return readJsonOrThrow<SearchResponse>(response, "image search failed");
}

export async function searchHybrid(
  text: string,
  file: File,
  alpha = 0.5,
  topK = 24,
  refresh = false,
  latencyTarget = 300,
): Promise<SearchResponse> {
  const formData = new FormData();
  formData.append("query", text);
  formData.append("image", file);
  formData.append("alpha", String(alpha));
  formData.append("top_k", String(topK));
  formData.append("refresh", String(refresh));
  formData.append("latency_target", String(latencyTarget));

  const response = await fetch(`${API_BASE}/search/hybrid`, {
    method: "POST",
    body: formData,
  });

  return readJsonOrThrow<SearchResponse>(response, "hybrid search failed");
}

export async function searchSimilar(
  productId: string,
  query?: string,
  topK = 24,
  refresh = false,
): Promise<SearchResponse> {
  const response = await fetch(`${API_BASE}/search/similar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
      query: query?.trim() || null,
      top_k: topK,
      refresh,
    }),
  });

  return readJsonOrThrow<SearchResponse>(response, "similar search failed");
}
