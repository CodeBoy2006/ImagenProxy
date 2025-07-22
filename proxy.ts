import { load } from "https://deno.land/std@0.208.0/dotenv/mod.ts";
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// 尝试从 .env 文件加载变量到进程环境
await load({ export: true });

// --- 接口定义 ---
interface Config {
  port: number;
  geminiApiKeys: string[];
  geminiBaseUrl: string;
  proxyAuthKeys: Set<string>;
  isAuthEnabled: boolean;
  maxRetries: number;
  retryDelay: number;
  maxConcurrent: number;
}
type ImageRequest = Record<string, any>;
interface ImageResponse { /* ... */ }

// --- 代理服务核心类 ---
class GeminiImageProxy {
  private config: Config;
  private keyUsageCount: Map<string, number> = new Map();
  private semaphore: Semaphore;

  constructor() {
    const keysFromEnv = Deno.env.get("GEMINI_API_KEYS") || "";
    const authKeysFromEnv = Deno.env.get("PROXY_AUTH_KEYS") || "";
    const proxyAuthKeys = new Set(authKeysFromEnv.split(',').map(k => k.trim()).filter(Boolean));

    this.config = {
      port: parseInt(Deno.env.get("PORT") || "8000"),
      geminiApiKeys: keysFromEnv.split(",").filter(key => key.trim()),
      geminiBaseUrl: Deno.env.get("GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai",
      proxyAuthKeys: proxyAuthKeys,
      isAuthEnabled: proxyAuthKeys.size > 0,
      maxRetries: parseInt(Deno.env.get("MAX_RETRIES") || "3"),
      retryDelay: parseInt(Deno.env.get("RETRY_DELAY") || "1000"),
      maxConcurrent: parseInt(Deno.env.get("MAX_CONCURRENT") || "10"),
    };

    if (this.config.geminiApiKeys.length === 0) {
      throw new Error("No Gemini API keys provided. Ensure GEMINI_API_KEYS is set in your environment or in a .env file.");
    }

    this.semaphore = new Semaphore(this.config.maxConcurrent);
    this.config.geminiApiKeys.forEach(key => this.keyUsageCount.set(key, 0));

    console.log(`🚀 Gemini Imagen Proxy (Transparent Mode) initialized with ${this.config.geminiApiKeys.length} API keys`);
    if (this.config.isAuthEnabled) {
      console.log(`🔐 Proxy authentication ENABLED with ${this.config.proxyAuthKeys.size} key(s).`);
    } else {
      console.log("🔓 Proxy authentication is DISABLED.");
    }
  }

  private isAuthorized(request: Request): { authorized: boolean; response?: Response } {
    if (!this.config.isAuthEnabled) return { authorized: true };
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return { authorized: false, response: new Response(JSON.stringify({ error: { message: "Authorization header is missing.", type: "auth_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }) };
    }
    const [type, token] = authHeader.split(" ");
    if (type !== "Bearer" || !token) {
      return { authorized: false, response: new Response(JSON.stringify({ error: { message: "Authorization header must be in 'Bearer <token>' format.", type: "auth_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }) };
    }
    if (!this.config.proxyAuthKeys.has(token)) {
      return { authorized: false, response: new Response(JSON.stringify({ error: { message: "Invalid authorization token.", type: "auth_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }) };
    }
    return { authorized: true };
  }

  private getNextApiKey(): string {
    let selectedKey = this.config.geminiApiKeys[0];
    let minUsage = this.keyUsageCount.get(selectedKey) ?? Infinity;
    for (const key of this.config.geminiApiKeys) {
      const usage = this.keyUsageCount.get(key) || 0;
      if (usage < minUsage) { minUsage = usage; selectedKey = key; }
    }
    this.keyUsageCount.set(selectedKey, minUsage + 1);
    return selectedKey;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private mapModelName(originalModel: string): string {
    const modelMapping: Record<string, string> = {
      "imagen-3": "imagen-3.0-generate-002",
      "imagen-4": "imagen-4.0-generate-preview-06-06",
      "imagen-4-ultra": "imagen-4.0-ultra-generate-preview-06-06",
    };
    return modelMapping[originalModel] || originalModel;
  }

  private async generateImage(originalRequest: ImageRequest, apiKey: string): Promise<ImageResponse> {
    const geminiRequest = { ...originalRequest };

    // --- 新增的过滤逻辑 ---
    // 过滤掉上游 API 不支持的 'seed' 参数以防止错误。
    if ('seed' in geminiRequest) {
      delete geminiRequest.seed;
      console.log('ℹ️ Filtered out unsupported "seed" parameter from the request.');
    }
    // --- 过滤逻辑结束 ---

    geminiRequest.model = this.mapModelName(originalRequest.model);

    if (!geminiRequest.response_format) {
        geminiRequest.response_format = 'b64_json';
    }

    console.log(`🎨 Forwarding request for model: ${geminiRequest.model}, prompt: "${String(geminiRequest.prompt).substring(0, 50)}..."`);
    const apiUrl = `${this.config.geminiBaseUrl}/images/generations`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(geminiRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Gemini API error (${response.status}) for key ...${apiKey.slice(-4)}:`, errorText);
      if (response.status === 429) throw new Error("RATE_LIMITED");
      if (response.status === 401) throw new Error("INVALID_API_KEY");
      if (response.status >= 500) throw new Error("SERVER_ERROR");
      throw new Error(`UPSTREAM_API_ERROR: ${response.status} - ${errorText}`);
    }

    return await response.json();
  }

  private async generateWithRetry(request: ImageRequest): Promise<ImageResponse> {
    let lastError: Error | null = null;
    const usedKeys = new Set<string>();

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      let apiKey = this.getNextApiKey();
      if (usedKeys.size >= this.config.geminiApiKeys.length) usedKeys.clear();
      while (usedKeys.has(apiKey) && usedKeys.size < this.config.geminiApiKeys.length) {
        apiKey = this.getNextApiKey();
      }
      usedKeys.add(apiKey);

      try {
        console.log(`🔄 Attempt ${attempt + 1}/${this.config.maxRetries} with key ending in ...${apiKey.slice(-8)}`);
        const result = await this.generateImage(request, apiKey);
        console.log(`✅ Image generated successfully on attempt ${attempt + 1}`);
        return result;
      } catch (error) {
        lastError = error as Error;
        console.warn(`⚠️ Attempt ${attempt + 1} failed:`, lastError.message);
        if (lastError.message.includes("RATE_LIMITED")) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          console.log(`⏳ Rate limited, waiting ${delay}ms before retry`);
          await this.sleep(delay);
        } else if (attempt < this.config.maxRetries - 1) {
          await this.sleep(this.config.retryDelay);
        }
      }
    }
    throw lastError || new Error("Max retries exceeded");
  }

  async handleRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }

    const authResult = this.isAuthorized(request);
    if (!authResult.authorized) return authResult.response!;

    const { pathname } = new URL(request.url);

    if (request.method !== "POST" || pathname !== "/v1/images/generations") {
      return new Response(JSON.stringify({ error: { message: `Not Found. The correct endpoint is POST /v1/images/generations`, type: "invalid_request_error" } }), {
        status: 404, headers: { "Content-Type": "application/json" }
      });
    }

    try {
      const imageRequest = await request.json() as ImageRequest;
      if (!imageRequest.model || !imageRequest.prompt) {
        return new Response(JSON.stringify({ error: { message: "Missing required fields: model and prompt", type: "invalid_request_error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      
      await this.semaphore.acquire();
      try {
        const result = await this.generateWithRetry(imageRequest);
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } finally {
        this.semaphore.release();
      }
    } catch (error) {
      console.error("❌ Request handling error:", error);
      const errorMessage = error instanceof Error ? error.message : "Internal server error";
      const statusCode = errorMessage.startsWith("UPSTREAM_API_ERROR") ? 400 : 500;
      return new Response(JSON.stringify({ error: { message: errorMessage, type: "api_error" } }), { status: statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
  }

  async start(): Promise<void> {
    const handler = (request: Request) => this.handleRequest(request);
    console.log(`🌟 Gemini Imagen Proxy Server starting on http://localhost:${this.config.port}`);
    console.log(`   - Endpoint: POST /v1/images/generations`);
    await serve(handler, { port: this.config.port });
  }
}

// --- 并发控制信号量类 ---
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise<void>((resolve) => { this.waiting.push(resolve); });
  }
  release(): void {
    this.permits++;
    if (this.waiting.length > 0) { this.permits--; this.waiting.shift()!(); }
  }
}

// --- 启动服务 ---
if (import.meta.main) {
  try {
    const proxy = new GeminiImageProxy();
    await proxy.start();
  } catch (error) {
    console.error(`❌ Failed to start proxy server: ${error.message}`);
    Deno.exit(1);
  }
}