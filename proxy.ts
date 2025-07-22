import { load } from "https://deno.land/std@0.208.0/dotenv/mod.ts";
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// 加载环境变量
const env = await load();

interface Config {
  port: number;
  geminiApiKeys: string[];
  geminiBaseUrl: string;
  maxRetries: number;
  retryDelay: number;
  maxConcurrent: number;
}

// 使用 Record<string, any> 使其更灵活，可以接受任何参数
type ImageRequest = Record<string, any>;

interface ImageResponse {
  created: number;
  data: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
}

class GeminiImageProxy {
  private config: Config;
  private keyUsageCount: Map<string, number> = new Map();
  private semaphore: Semaphore;

  constructor() {
    this.config = {
      port: parseInt(env.PORT || "8000"),
      geminiApiKeys: (env.GEMINI_API_KEYS || "").split(",").filter(key => key.trim()),
      geminiBaseUrl: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      maxRetries: parseInt(env.MAX_RETRIES || "3"),
      retryDelay: parseInt(env.RETRY_DELAY || "1000"),
      maxConcurrent: parseInt(env.MAX_CONCURRENT || "10"),
    };

    if (this.config.geminiApiKeys.length === 0) {
      throw new Error("No Gemini API keys provided in GEMINI_API_KEYS");
    }

    this.semaphore = new Semaphore(this.config.maxConcurrent);
    
    this.config.geminiApiKeys.forEach(key => this.keyUsageCount.set(key, 0));

    console.log(`🚀 Gemini Imagen Proxy (Transparent Mode) initialized with ${this.config.geminiApiKeys.length} API keys`);
  }

  private getNextApiKey(): string {
    let selectedKey = this.config.geminiApiKeys[0];
    let minUsage = this.keyUsageCount.get(selectedKey) ?? Infinity;

    for (const key of this.config.geminiApiKeys) {
      const usage = this.keyUsageCount.get(key) || 0;
      if (usage < minUsage) {
        minUsage = usage;
        selectedKey = key;
      }
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
    // 如果有映射则使用映射值，否则直接透传原始模型名称
    return modelMapping[originalModel] || originalModel;
  }

  private async generateImage(originalRequest: ImageRequest, apiKey: string): Promise<ImageResponse> {
    // 复制原始请求，以避免修改传入的对象
    const geminiRequest = { ...originalRequest };
    
    // 映射模型名称，但保留所有其他参数
    geminiRequest.model = this.mapModelName(originalRequest.model);

    // 确保返回格式为 b64_json，因为这是脚本的核心功能
    if (!geminiRequest.response_format) {
        geminiRequest.response_format = 'b64_json';
    }

    console.log(`🎨 Forwarding image generation request for model: ${geminiRequest.model}`);

    const apiUrl = `${this.config.geminiBaseUrl}/images/generations`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(geminiRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Gemini API error (${response.status}):`, errorText);
      
      if (response.status === 429) throw new Error("RATE_LIMITED");
      if (response.status === 401) throw new Error("INVALID_API_KEY");
      if (response.status >= 500) throw new Error("SERVER_ERROR");
      
      // 将上游的错误信息直接抛出
      throw new Error(`UPSTREAM_API_ERROR: ${response.status} - ${errorText}`);
    }

    return await response.json();
  }

  private async generateWithRetry(request: ImageRequest): Promise<ImageResponse> {
    let lastError: Error | null = null;
    const usedKeys = new Set<string>();

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      let apiKey = this.getNextApiKey();
      
      if (usedKeys.size >= this.config.geminiApiKeys.length) {
        usedKeys.clear();
      }
      
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
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/images/generations") {
        return new Response(JSON.stringify({ error: "Not Found. Endpoint should be POST /images/generations" }), { 
            status: 404,
            headers: { "Content-Type": "application/json" }
        });
    }

    try {
      const imageRequest = await request.json() as ImageRequest;

      // 基本的健全性检查
      if (!imageRequest.model || !imageRequest.prompt) {
        return new Response(JSON.stringify({
          error: { message: "Missing required fields: model and prompt", type: "invalid_request_error" }
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      
      await this.semaphore.acquire();
      try {
        const result = await this.generateWithRetry(imageRequest);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } finally {
        this.semaphore.release();
      }

    } catch (error) {
      console.error("❌ Request handling error:", error);
      const errorMessage = error instanceof Error ? error.message : "Internal server error";
      const statusCode = errorMessage.startsWith("UPSTREAM_API_ERROR") ? 400 : 500;
      
      return new Response(JSON.stringify({
        error: { message: errorMessage, type: "api_error" }
      }), { status: statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
  }

  async start(): Promise<void> {
    const handler = (request: Request) => this.handleRequest(request);
    console.log(`🌟 Gemini Imagen Proxy Server starting on http://localhost:${this.config.port}`);
    console.log(`   - Endpoint: POST /images/generations`);
    console.log(`   - Mode: Transparent (minimal validation)`);
    await serve(handler, { port: this.config.port });
  }
}

// 信号量类用于控制并发 (保持不变)
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

if (import.meta.main) {
  try {
    const proxy = new GeminiImageProxy();
    await proxy.start();
  } catch (error) {
    console.error("❌ Failed to start proxy server:", error);
    Deno.exit(1);
  }
}