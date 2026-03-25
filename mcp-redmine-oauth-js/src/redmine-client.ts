export class RedmineAPIError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export class RedmineAuthError extends RedmineAPIError {}
export class RedmineForbiddenError extends RedmineAPIError {}
export class RedmineNotFoundError extends RedmineAPIError {}

export class RedmineValidationError extends RedmineAPIError {
  constructor(statusCode: number, message: string, public readonly errors: string[] = []) {
    super(statusCode, message);
  }
}

export class RedmineClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async get(path: string, token: string, params?: Record<string, string | number>): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }
    return (await this.request(url.toString(), "GET", token)) as Record<string, unknown>;
  }

  async post(path: string, token: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.request(`${this.baseUrl}${path}`, "POST", token, body)) as Record<string, unknown>;
  }

  async put(path: string, token: string, body?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const result = await this.request(`${this.baseUrl}${path}`, "PUT", token, body, true);
    return result;
  }

  private async request(
    url: string,
    method: "GET" | "POST" | "PUT",
    token: string,
    body?: Record<string, unknown>,
    allowNoContent = false
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });

      await this.raiseForStatus(response);
      if (allowNoContent && response.status === 204) {
        return null;
      }
      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async raiseForStatus(response: Response): Promise<void> {
    if (response.status === 401) {
      throw new RedmineAuthError(401, "Authentication failed - token may be expired.");
    }
    if (response.status === 403) {
      throw new RedmineForbiddenError(403, "Permission denied.");
    }
    if (response.status === 404) {
      throw new RedmineNotFoundError(404, "Resource not found in Redmine.");
    }
    if (response.status === 422) {
      let errors: string[] = [];
      try {
        const body = (await response.json()) as { errors?: string[] };
        errors = Array.isArray(body.errors) ? body.errors : [];
      } catch {
        errors = [];
      }
      throw new RedmineValidationError(
        422,
        `Validation failed: ${errors.length > 0 ? errors.join("; ") : "unknown error"}`,
        errors
      );
    }
    if (response.status >= 500) {
      throw new RedmineAPIError(response.status, `Redmine server error (${response.status}).`);
    }
    if (response.status >= 400) {
      throw new RedmineAPIError(response.status, `Redmine request failed (${response.status}).`);
    }
  }
}
