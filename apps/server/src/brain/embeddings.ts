const OLLAMA_EMBEDDINGS_URL = "http://localhost:11434/api/embeddings";
const OLLAMA_EMBEDDINGS_MODEL = "bge-m3";
const EMBEDDING_TIMEOUT_MS = 2_000;
const EMBEDDING_WARMUP_TIMEOUT_MS = 30_000;
const EMBEDDING_CACHE_CAP = 2_000;
const OBS_EMBEDDING_CACHE_CAP = 5_000;

type CacheValue = number[] | null;

const cache = new Map<string, CacheValue>();
const obsEmbeddingCache = new Map<string, number[]>();

function remember(text: string, value: CacheValue): CacheValue {
  if (cache.has(text)) cache.delete(text);
  cache.set(text, value);
  while (cache.size > EMBEDDING_CACHE_CAP) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

export function getCachedObsEmbedding(obsId: string): number[] | undefined {
  const cached = obsEmbeddingCache.get(obsId);
  if (cached) {
    obsEmbeddingCache.delete(obsId);
    obsEmbeddingCache.set(obsId, cached);
  }
  return cached;
}

export function setCachedObsEmbedding(obsId: string, vec: number[]): void {
  if (!obsId || vec.length === 0) return;
  if (obsEmbeddingCache.has(obsId)) obsEmbeddingCache.delete(obsId);
  obsEmbeddingCache.set(obsId, vec);
  while (obsEmbeddingCache.size > OBS_EMBEDDING_CACHE_CAP) {
    const oldest = obsEmbeddingCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    obsEmbeddingCache.delete(oldest);
  }
}

export async function warmEmbeddingModel(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_WARMUP_TIMEOUT_MS);
  try {
    await fetch(OLLAMA_EMBEDDINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_EMBEDDINGS_MODEL,
        prompt: "warmup",
        keep_alive: "60m"
      })
    });
  } catch {
    // Best-effort warmup; runtime embedding calls will retry.
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  const key = text.trim();
  if (!key) return null;
  if (cache.has(key)) {
    const cached = cache.get(key) ?? null;
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const res = await fetch(OLLAMA_EMBEDDINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_EMBEDDINGS_MODEL,
        prompt: key,
        keep_alive: "30m"
      })
    });
    if (!res.ok) return null;
    let json: { embedding?: unknown };
    try {
      json = await res.json() as { embedding?: unknown };
    } catch {
      return remember(key, null);
    }
    const embedding = Array.isArray(json.embedding)
      ? json.embedding.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
    return remember(key, embedding.length > 0 ? embedding : null);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a?.length || !b?.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
