// =============================================================================
// 🚀 SMART DYNAMIC TIMEOUT SYSTEM — Vercel 60s Limit Protection
// =============================================================================
// Har API call ke liye dynamic timeout management:
// - Fast Response: Agar API 5s mein answer de, toh turant aage badho
// - Max Limit: Koi bhi API 60s se zyada na le, gracefully fail ho
// - Global Budget: Poore request ka total time track karo
// =============================================================================

/**
 * Per-API timeout limits (in milliseconds).
 * Har ek API ka apna max allowed time hai.
 * Agar koi API isse zyada le, toh abort ho jayegi.
 */
export const API_TIMEOUTS = {
  // Page fetching
  PROXY_FETCH: 20_000,       // Cloudscraper proxy: max 20s
  DIRECT_FETCH: 12_000,      // Direct fetch fallback: max 12s

  // Solver APIs
  HBLINKS: 10_000,           // HBLinks solver: max 10s
  HUBCDN: 12_000,            // HubCDN solver: max 12s
  HUBDRIVE: 10_000,          // HubDrive solver: max 10s
  HUBCLOUD_API: 20_000,      // HubCloud Python API: max 20s (heaviest)

  // External APIs
  TIMER_BYPASS: 15_000,      // Timer bypass API: max 15s
  TELEGRAM: 5_000,           // Telegram alerts: max 5s

  // Axios defaults
  AXIOS_DEFAULT: 8_000,      // Default axios timeout
} as const;

/**
 * VERCEL GLOBAL BUDGET TRACKER
 * --
 * Vercel Hobby = 10s, Pro = 60s limit.
 * Hum 55s ka safe budget rakhte hain taaki cleanup ho sake.
 */
const VERCEL_SAFE_LIMIT_MS = 55_000; // 55 seconds — 5s buffer for cleanup

export class GlobalTimeoutBudget {
  private startTime: number;
  private maxBudgetMs: number;

  constructor(maxBudgetMs: number = VERCEL_SAFE_LIMIT_MS) {
    this.startTime = Date.now();
    this.maxBudgetMs = maxBudgetMs;
  }

  /** Kitna time beet chuka hai (ms) */
  get elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** Kitna time bacha hai (ms) */
  get remaining(): number {
    return Math.max(0, this.maxBudgetMs - this.elapsed);
  }

  /** Kya time khatam ho gaya? */
  get isExpired(): boolean {
    return this.remaining <= 0;
  }

  /**
   * Ek specific API ke liye timeout calculate karo.
   * Jo bhi chhota ho — API ka own limit ya remaining budget — wo use hoga.
   * Minimum 2 seconds dega (taaki at least ek try ho sake).
   */
  getTimeoutForAPI(apiMaxMs: number): number {
    const available = this.remaining;
    if (available <= 0) return 0;
    // Jo chhota ho wo lo, but minimum 2s
    return Math.max(2000, Math.min(apiMaxMs, available));
  }

  /**
   * AbortSignal banao jo automatically timeout ho jayega.
   * -- Agar API fast respond kare, toh turant aage badho (ye AbortSignal ki nature hai)
   * -- Agar slow ho, toh max time pe abort ho jayega
   */
  createSignalForAPI(apiMaxMs: number): AbortSignal {
    const timeout = this.getTimeoutForAPI(apiMaxMs);
    if (timeout <= 0) {
      // Already expired — immediately abort
      return AbortSignal.abort(new Error('Global timeout budget expired'));
    }
    return AbortSignal.timeout(timeout);
  }

  /** Human readable status */
  getStatus(): string {
    return `[Budget] Elapsed: ${(this.elapsed / 1000).toFixed(1)}s | Remaining: ${(this.remaining / 1000).toFixed(1)}s`;
  }
}

/**
 * SAFE FETCH WITH TIMEOUT
 * --
 * Wrapper around fetch() that:
 * 1. Har call mein AbortSignal.timeout lagata hai
 * 2. Fast response pe turant resolve hota hai
 * 3. Slow response pe max limit hit hote hi abort karta hai
 * 4. Clean error message deta hai
 */
export async function safeFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
  budget?: GlobalTimeoutBudget
): Promise<Response> {
  const { timeoutMs = API_TIMEOUTS.AXIOS_DEFAULT, ...fetchOptions } = options;

  // Calculate actual timeout considering global budget
  const actualTimeout = budget
    ? budget.getTimeoutForAPI(timeoutMs)
    : timeoutMs;

  if (actualTimeout <= 0) {
    throw new Error(`⏱️ Timeout: Global budget expired (0ms remaining)`);
  }

  // Create abort controller for this specific call
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`⏱️ Timeout: API took longer than ${(actualTimeout / 1000).toFixed(1)}s`));
  }, actualTimeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new Error(`⏱️ Timeout after ${(actualTimeout / 1000).toFixed(1)}s: ${url.substring(0, 80)}...`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SAFE AXIOS WRAPPER
 * --
 * Axios ke liye timeout + AbortController wrapper.
 * Axios ka built-in timeout + extra AbortSignal dono lagata hai.
 */
export function getAxiosConfig(
  apiMaxMs: number,
  budget?: GlobalTimeoutBudget,
  extraConfig: Record<string, any> = {}
): Record<string, any> {
  const actualTimeout = budget
    ? budget.getTimeoutForAPI(apiMaxMs)
    : apiMaxMs;

  if (actualTimeout <= 0) {
    throw new Error('⏱️ Timeout: Global budget expired');
  }

  const controller = new AbortController();

  // Safety net: force abort after timeout (in case axios timeout doesn't fire)
  const timer = setTimeout(() => {
    controller.abort();
  }, actualTimeout + 1000); // +1s grace period beyond axios timeout

  // Store timer reference for cleanup
  const config = {
    ...extraConfig,
    timeout: actualTimeout,
    signal: controller.signal,
    _cleanupTimer: timer, // caller can clear this if needed
  };

  return config;
}

/**
 * RACE WITH TIMEOUT
 * --
 * Kisi bhi promise ko ek max time limit ke saath race karao.
 * Agar promise time se pehle resolve ho → result milega
 * Agar time khatam → clean error throw hoga
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string = 'Operation'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`⏱️ ${label} timed out after ${(timeoutMs / 1000).toFixed(1)}s`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (error) {
    clearTimeout(timer!);
    throw error;
  }
}
