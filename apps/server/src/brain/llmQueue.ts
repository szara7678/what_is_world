export type LlmQueuePriority = "action" | "reflection";

type QueueItem = {
  id: number;
  priority: LlmQueuePriority;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  enqueuedAt: number;
  resolve: (res: Response) => void;
  reject: (error: unknown) => void;
};

type LlmQueueStats = {
  actionCount: number;
  reflectionCount: number;
  droppedCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxPending: number;
  pending: number;
  running: number;
};

const MAX_QUEUE_SIZE = 20;
const MAX_LATENCY_SAMPLES = 500;

const queue: QueueItem[] = [];
const actionRunning = new Set<number>();
const reflectionRunning = new Set<number>();
let nextId = 1;
let actionCount = 0;
let reflectionCount = 0;
let droppedCount = 0;
let latencyTotalMs = 0;
let completedCount = 0;
let maxPending = 0;
let actionConcurrency = 2;
let reflectionConcurrency = 1;
const latencySamples: number[] = [];

export function configureLlmQueue(options: { concurrency?: number; reflectionConcurrency?: number }): void {
  if (options.concurrency !== undefined) {
    actionConcurrency = Math.max(1, Math.floor(options.concurrency));
  }
  if (options.reflectionConcurrency !== undefined) {
    reflectionConcurrency = Math.max(0, Math.floor(options.reflectionConcurrency));
  }
  drain();
}

export function enqueueLlmRequest(args: {
  priority: LlmQueuePriority;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const item: QueueItem = {
      id: nextId++,
      priority: args.priority,
      url: args.url,
      init: args.init,
      timeoutMs: args.timeoutMs,
      enqueuedAt: Date.now(),
      resolve,
      reject
    };

    queue.push(item);
    maxPending = Math.max(maxPending, queue.length);
    enforceQueueLimit();
    drain();
  });
}

export function getLlmQueueStats(): LlmQueueStats {
  const avgLatencyMs = completedCount > 0 ? latencyTotalMs / completedCount : 0;
  const sorted = [...latencySamples].sort((a, b) => a - b);
  return {
    actionCount,
    reflectionCount,
    droppedCount,
    avgLatencyMs: Number(avgLatencyMs.toFixed(1)),
    p50LatencyMs: percentile(sorted, 0.5),
    p95LatencyMs: percentile(sorted, 0.95),
    maxPending,
    pending: queue.length,
    running: actionRunning.size + reflectionRunning.size
  };
}

function enforceQueueLimit(): void {
  while (queue.length > MAX_QUEUE_SIZE) {
    const dropIndex = queue.findIndex((item) => item.priority === "reflection");
    if (dropIndex < 0) return;
    const [dropped] = queue.splice(dropIndex, 1);
    if (!dropped) return;
    droppedCount += 1;
    dropped.reject(new Error("llm_queue_reflection_dropped"));
  }
}

function drain(): void {
  // Action lane
  while (actionRunning.size < actionConcurrency) {
    const next = takeNextOf("action");
    if (!next) break;
    actionRunning.add(next.id);
    void run(next).finally(() => {
      actionRunning.delete(next.id);
      drain();
    });
  }
  // Reflection lane (별도 슬롯 — action에 밀리지 않음)
  while (reflectionRunning.size < reflectionConcurrency) {
    const next = takeNextOf("reflection");
    if (!next) break;
    reflectionRunning.add(next.id);
    void run(next).finally(() => {
      reflectionRunning.delete(next.id);
      drain();
    });
  }
}

function takeNextOf(priority: LlmQueuePriority): QueueItem | null {
  const index = queue.findIndex((item) => item.priority === priority);
  if (index < 0) return null;
  const [item] = queue.splice(index, 1);
  return item ?? null;
}

async function run(item: QueueItem): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), item.timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(item.url, {
      ...item.init,
      signal: controller.signal
    });
    if (item.priority === "action") actionCount += 1;
    else reflectionCount += 1;
    const latencyMs = Date.now() - startedAt;
    latencyTotalMs += latencyMs;
    completedCount += 1;
    latencySamples.push(latencyMs);
    if (latencySamples.length > MAX_LATENCY_SAMPLES) latencySamples.splice(0, latencySamples.length - MAX_LATENCY_SAMPLES);
    item.resolve(res);
  } catch (error) {
    item.reject(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Number(sorted[index].toFixed(1));
}
