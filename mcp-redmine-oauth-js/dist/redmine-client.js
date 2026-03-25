export class RedmineAPIError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
export class RedmineAuthError extends RedmineAPIError {
}
export class RedmineForbiddenError extends RedmineAPIError {
}
export class RedmineNotFoundError extends RedmineAPIError {
}
export class RedmineValidationError extends RedmineAPIError {
    errors;
    constructor(statusCode, message, errors = []) {
        super(statusCode, message);
        this.errors = errors;
    }
}
export class RedmineClient {
    baseUrl;
    timeoutMs;
    constructor(baseUrl, timeoutMs = 30_000) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.timeoutMs = timeoutMs;
    }
    async get(path, token, params) {
        const url = new URL(`${this.baseUrl}${path}`);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url.searchParams.set(k, String(v));
            }
        }
        return (await this.request(url.toString(), "GET", token));
    }
    async post(path, token, body) {
        return (await this.request(`${this.baseUrl}${path}`, "POST", token, body));
    }
    async put(path, token, body) {
        const result = await this.request(`${this.baseUrl}${path}`, "PUT", token, body, true);
        return result;
    }
    async request(url, method, token, body, allowNoContent = false) {
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
            return (await response.json());
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async raiseForStatus(response) {
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
            let errors = [];
            try {
                const body = (await response.json());
                errors = Array.isArray(body.errors) ? body.errors : [];
            }
            catch {
                errors = [];
            }
            throw new RedmineValidationError(422, `Validation failed: ${errors.length > 0 ? errors.join("; ") : "unknown error"}`, errors);
        }
        if (response.status >= 500) {
            throw new RedmineAPIError(response.status, `Redmine server error (${response.status}).`);
        }
        if (response.status >= 400) {
            throw new RedmineAPIError(response.status, `Redmine request failed (${response.status}).`);
        }
    }
}
