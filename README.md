# OpenAI-Compatible Gemini Imagen Proxy

This is a high-performance, Deno-based proxy server that allows you to use Google's Gemini Imagen API through an OpenAI-compatible interface. It acts as a secure and robust bridge, enabling you to use any client library or tool designed for the OpenAI API (e.g., `openai-python`, `openai-node`) to generate images with Gemini.

The server is designed for production use, featuring multi-key load balancing, intelligent retries, concurrency limiting, and bearer token authentication.

## ✨ Features

-   **OpenAI Compatibility**: Drop-in replacement endpoint (`/v1/images/generations`) for OpenAI image generation clients.
-   **Multi-Key Load Balancing**: Distributes requests across multiple Gemini API keys to avoid rate limits.
-   **Smart Retries**: Automatically retries failed requests with exponential backoff.
-   **Concurrency Control**: Limits the number of simultaneous requests to the upstream API to prevent overload.
-   **Secure Authentication**: Protects your proxy endpoint with mandatory Bearer Token authentication.
-   **Parameter Filtering**: Automatically removes unsupported parameters (like `seed`) to prevent upstream API errors.
-   **Easy Configuration**: All settings are managed through a simple `.env` file.

## 🚀 Getting Started

### Prerequisites

-   [Deno](https://deno.land/) (v1.x or later) installed on your machine.

### Installation

1.  **Clone the repository or download the script**
    Save the `proxy.ts` script to a new project directory.

2.  **Create the configuration file**
    Create a file named `.env` in the same directory as `proxy.ts`. You can copy the example below to get started.

3.  **Install dependencies and run**
    Deno will automatically download dependencies on the first run.

## ⚙️ Configuration (`.env` file)

All configuration is handled through an `.env` file in the root of the project. This file is essential for the server to run correctly.

Below is an explanation of each variable you can set.

---

### `.env.example`

```env
# ---------------------------------------------------
# REQUIRED SETTINGS
# ---------------------------------------------------

# Your Google Gemini API Keys, separated by commas.
# The proxy will rotate through these keys to distribute the load.
GEMINI_API_KEYS=your_gemini_key_1,your_gemini_key_2,another_key

# ---------------------------------------------------
# SECURITY SETTINGS (HIGHLY RECOMMENDED)
# ---------------------------------------------------

# Secret keys for authenticating with this proxy, separated by commas.
# Clients must provide one of these keys in the 'Authorization: Bearer <key>' header.
# If this variable is left empty or commented out, the proxy will be open to the public (NOT RECOMMENDED).
PROXY_AUTH_KEYS=proxy-secret-token-abc-123,secure-access-key-xyz-789

# ---------------------------------------------------
# OPTIONAL SETTINGS
# ---------------------------------------------------

# The port on which the proxy server will run.
# Default: 8000
PORT=8000

# The base URL for the Gemini OpenAI-compatible API.
# You typically do not need to change this.
# Default: https://generativelanguage.googleapis.com/v1beta/openai
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai

# The maximum number of concurrent requests to send to the Gemini API.
# Helps prevent 429 "Too Many Requests" errors.
# Default: 10
MAX_CONCURRENT=10

# The maximum number of retries for a failed request.
# Default: 3
MAX_RETRIES=3

# The base delay in milliseconds for retries.
# The delay increases exponentially with each retry (e.g., 1000ms, 2000ms, 4000ms).
# Default: 1000
RETRY_DELAY=1000
```

### Variable Details

-   `GEMINI_API_KEYS` (**Required**)
    This is a comma-separated list of your API keys from Google AI Studio. The proxy will cycle through these keys to balance the request load and handle key-specific rate limits gracefully.

-   `PROXY_AUTH_KEYS` (**Required for Security**)
    A comma-separated list of secret tokens that you create. Any client wanting to use this proxy must send an `Authorization` header with one of these tokens (e.g., `Authorization: Bearer proxy-secret-token-abc-123`). If this variable is empty, your proxy will be unsecured and open to anyone.

-   `PORT` (*Optional*)
    The network port for the server. Defaults to `8000`.

-   `MAX_CONCURRENT` (*Optional*)
    Sets a limit on how many requests the proxy can have "in-flight" to the Gemini API at any one time. This is a crucial setting for managing rate limits. Defaults to `10`.

-   `MAX_RETRIES` (*Optional*)
    The number of times the proxy will re-attempt a failed request before returning an error. Defaults to `3`.

-   `RETRY_DELAY` (*Optional*)
    The initial wait time in milliseconds before the first retry. Defaults to `1000`.

## 💻 Running the Server

Once your `.env` file is configured, you can start the server using Deno tasks (if you have a `deno.json` file) or a direct command.

```bash
# Start the server (recommended for production)
deno run --allow-net --allow-env --allow-read proxy.ts

# Or start in watch mode for development (restarts on file changes)
deno run --allow-net --allow-env --allow-read --watch proxy.ts
```

Upon successful startup, you will see a confirmation message in your terminal:
`🌟 Gemini Imagen Proxy Server starting on http://localhost:8000`

## 🕹️ Usage Example

You can now send requests to your proxy's `/v1/images/generations` endpoint using any HTTP client or OpenAI library.

Here is an example using `curl`:

```bash
curl -X POST http://localhost:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer proxy-secret-token-abc-123" \
  -d '{
    "model": "imagen-4.0-generate-preview-06-06",
    "prompt": "A photorealistic portrait of an astronaut dog on Mars",
    "n": 1,
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

The response will be in the standard OpenAI format, containing base64-encoded image data.