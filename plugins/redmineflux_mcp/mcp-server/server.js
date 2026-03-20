import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import axios from "axios"
import { createProxyMiddleware } from "http-proxy-middleware"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REDMINE_URL        = normalizeBaseUrl(process.env.REDMINE_URL || "http://127.0.0.1:3000")
const REQUEST_TIMEOUT_MS = toPositiveInteger(process.env.REDMINE_TIMEOUT_MS, 20000)
const DEFAULT_LIMIT      = toPositiveInteger(process.env.REDMINE_DEFAULT_LIMIT, 25)
const TRANSPORT_MODE     = resolveTransportMode()
const HTTP_PORT          = toPositiveInteger(process.env.PORT || process.env.MCP_PORT, 3000)
const HTTP_HOST          = asStringOrNull(process.env.MCP_HOST) || "0.0.0.0"
const HTTP_PATH          = process.env.MCP_HTTP_PATH || "/mcp"
const REDMINE_PROXY_URL  = asStringOrNull(process.env.REDMINE_PROXY_URL)

// OAuth 2.0 settings (Redmine 6.1 built-in OAuth provider via Doorkeeper)
// Register your app at: Redmine → Administration → Applications → New application
// Set redirect URI to: {MCP_PUBLIC_URL}/oauth/callback
const OAUTH_CLIENT_ID     = asStringOrNull(process.env.OAUTH_CLIENT_ID)
const OAUTH_CLIENT_SECRET = asStringOrNull(process.env.OAUTH_CLIENT_SECRET)
const MCP_PUBLIC_URL      = normalizeBaseUrl(process.env.MCP_PUBLIC_URL || `http://localhost:${HTTP_PORT}`)

// Redmine 6.1 Doorkeeper OAuth endpoints
const OAUTH_AUTHORIZE_URL = `${REDMINE_URL}/oauth/authorize`
const OAUTH_TOKEN_URL     = `${REDMINE_URL}/oauth/token`

// Fallback: static API key (for single-user / no-OAuth setups)
const BASE_API_KEY = asStringOrNull(process.env.REDMINE_API_KEY)

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const sessionStates      = new Map()   // MCP session-id → session state
const oauthStateMap      = new Map()   // OAuth state param → { sessionId, redirectUri }
const requestContextStore = new AsyncLocalStorage()

const redmineClient = axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true
})

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

console.error(`[redmineflux-mcp] Starting MCP server for ${REDMINE_URL}`)
if (BASE_API_KEY) {
    console.error("[redmineflux-mcp] Auth mode: static REDMINE_API_KEY")
} else if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) {
    console.error("[redmineflux-mcp] Auth mode: Redmine 6.1 OAuth2")
    console.error(`[redmineflux-mcp] OAuth authorize → ${OAUTH_AUTHORIZE_URL}`)
    console.error(`[redmineflux-mcp] Callback URL   → ${MCP_PUBLIC_URL}/oauth/callback`)
} else {
    console.error("[redmineflux-mcp] Auth mode: none — set REDMINE_API_KEY or OAUTH_CLIENT_ID+OAUTH_CLIENT_SECRET")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asStringOrNull(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
}

function resolveTransportMode() {
    const explicit = asStringOrNull(process.env.MCP_TRANSPORT)
    if (explicit) return explicit.toLowerCase()
    return process.env.PORT ? "http" : "stdio"
}

function normalizeBaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "")
}

function toPositiveInteger(value, fallbackValue) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue
}

function compactObject(obj = {}) {
    return Object.fromEntries(
        Object.entries(obj).filter(([, v]) => {
            if (v === undefined || v === null) return false
            if (typeof v === "string" && v.trim() === "") return false
            return true
        })
    )
}

function normalizeArray(value) {
    if (value === undefined || value === null) return undefined
    return Array.isArray(value) ? value : [value]
}

function encodeWikiTitle(title) {
    return String(title).split("/").map(encodeURIComponent).join("/")
}

function responseText(text) {
    return { content: [{ type: "text", text }] }
}

function responseJson(payload) {
    return responseText(JSON.stringify(payload, null, 2))
}

function extractErrorMessage(response) {
    const payload = response?.data
    if (payload && typeof payload === "object") {
        if (typeof payload.message === "string" && payload.message.length) return payload.message
        if (typeof payload.error === "string" && payload.error.length) return payload.error
        if (Array.isArray(payload.errors) && payload.errors.length) return payload.errors.join(", ")
    }
    if (typeof payload === "string" && payload.length) return payload
    return `HTTP ${response?.status || "error"}`
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function createSessionState() {
    return {
        // Static API key path (env var or set_api_key tool)
        apiKey: BASE_API_KEY,
        // OAuth2 path
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,   // epoch ms
        username: null
    }
}

function sessionFor(extra) {
    const sessionId = extra?.sessionId
    if (!sessionId) {
        // Shared session for stdio or single-session HTTP
        if (!sessionStates.has("__shared__")) {
            sessionStates.set("__shared__", createSessionState())
        }
        return sessionStates.get("__shared__")
    }
    if (!sessionStates.has(sessionId)) {
        sessionStates.set(sessionId, createSessionState())
    }
    return sessionStates.get(sessionId)
}

function currentSession() {
    return sessionFor(requestContextStore.getStore())
}

// ---------------------------------------------------------------------------
// OAuth 2.0 helpers  (Redmine 6.1 — Doorkeeper-based)
// ---------------------------------------------------------------------------

/**
 * Build the URL to redirect a user to for Redmine OAuth consent.
 * Redmine 6.1 Doorkeeper scopes:  view_issues  add_issues  edit_issues
 *   view_time_entries  log_time  view_wiki_pages  edit_wiki_pages  etc.
 * Use "api" as a catch-all scope that maps to full REST API access.
 */
function buildOAuthAuthorizeUrl(state, redirectUri) {
    const params = new URLSearchParams({
        response_type: "code",
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "api",       // Redmine 6.1 Doorkeeper scope for full REST API access
        state
    })
    return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
async function exchangeCodeForTokens(code, redirectUri) {
    const response = await redmineClient.post(
        OAUTH_TOKEN_URL,
        new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    )

    if (response.status >= 400) {
        throw new Error(`OAuth token exchange failed: ${extractErrorMessage(response)}`)
    }

    return response.data  // { access_token, refresh_token, expires_in, token_type }
}

/**
 * Use a refresh token to obtain a new access token.
 */
async function refreshAccessToken(session) {
    if (!session.refreshToken) throw new Error("No refresh token available — please re-authorize.")

    const response = await redmineClient.post(
        OAUTH_TOKEN_URL,
        new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    )

    if (response.status >= 400) {
        // Refresh token is invalid/expired — clear it so the user re-authorizes
        session.accessToken  = null
        session.refreshToken = null
        session.tokenExpiresAt = null
        throw new Error("OAuth refresh token expired. Please re-authorize via the MCP connector.")
    }

    applyTokenResponse(session, response.data)
}

function applyTokenResponse(session, data) {
    session.accessToken  = data.access_token
    session.refreshToken = data.refresh_token || session.refreshToken  // Doorkeeper may not rotate refresh tokens
    session.tokenExpiresAt = data.expires_in
        ? Date.now() + (data.expires_in - 30) * 1000   // 30s safety buffer
        : null
}

function isTokenExpired(session) {
    if (!session.tokenExpiresAt) return false   // no expiry info → assume valid
    return Date.now() >= session.tokenExpiresAt
}

// ---------------------------------------------------------------------------
// Auth headers — priority: OAuth bearer > static API key
// ---------------------------------------------------------------------------

function buildAuthHeaders() {
    const session = currentSession()

    if (session.accessToken) {
        return {
            Accept: "application/json",
            Authorization: `Bearer ${session.accessToken}`
        }
    }

    if (session.apiKey) {
        return {
            Accept: "application/json",
            "X-Redmine-API-Key": session.apiKey
        }
    }

    return { Accept: "application/json" }
}

// ---------------------------------------------------------------------------
// Ensure the session has valid credentials before making an API call
// ---------------------------------------------------------------------------

async function ensureAuthenticated() {
    const session = currentSession()

    // Static API key — always valid
    if (session.apiKey) return

    // OAuth token exists — refresh if expired
    if (session.accessToken) {
        if (isTokenExpired(session)) {
            await refreshAccessToken(session)
        }
        return
    }

    // No credentials at all
    throw new Error(
        "Not authenticated. " +
        (OAUTH_CLIENT_ID
            ? "Please authorize via the MCP connector's 'Complete Authentication' button."
            : "Set REDMINE_API_KEY in Claude config or call set_api_key.")
    )
}

// ---------------------------------------------------------------------------
// Core Redmine request
// ---------------------------------------------------------------------------

async function redmineRequest({ method, path, params, data, requiresAuth = true }) {
    if (requiresAuth) await ensureAuthenticated()

    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    const url = `${REDMINE_URL}${normalizedPath}`

    const response = await redmineClient.request({
        method,
        url,
        params: compactObject(params || {}),
        data,
        headers: {
            ...buildAuthHeaders(),
            ...(data ? { "Content-Type": "application/json" } : {})
        }
    })

    if (response.status >= 400) {
        throw new Error(`${method.toUpperCase()} ${normalizedPath} failed: ${extractErrorMessage(response)}`)
    }

    return response
}

function responseFromRedmine(response, successMessage) {
    const body = response.data
    if (body !== undefined && body !== null && body !== "") return responseJson(body)
    return responseJson({ ok: true, status: response.status, message: successMessage })
}

function readResourceId(args, key = "id") {
    const value = args[key]
    if (value === undefined || value === null || String(value).trim() === "") {
        throw new Error(`Missing required argument: ${key}`)
    }
    return value
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const tools = []

function defineTool(name, description, inputSchema, handler) {
    tools.push({ name, description, inputSchema, handler })
}

const idProperty = { type: ["string", "integer"], description: "Numeric ID or identifier" }

const paginationProperties = {
    limit:  { type: "integer", minimum: 1, default: DEFAULT_LIMIT, description: "Page size" },
    offset: { type: "integer", minimum: 0, description: "Offset for pagination" }
}

// ---------------------------------------------------------------------------
// Auth tools
// ---------------------------------------------------------------------------

defineTool(
    "get_auth_status",
    "Check current authentication status and, if OAuth is configured, get the URL the user must visit to authorize.",
    { type: "object", properties: {} },
    async () => {
        const session = currentSession()
        const oauthConfigured = !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET)

        if (session.accessToken && !isTokenExpired(session)) {
            return responseJson({ authenticated: true, method: "oauth2", username: session.username || null })
        }

        if (session.apiKey) {
            return responseJson({ authenticated: true, method: "api_key" })
        }

        if (oauthConfigured) {
            const state       = randomUUID()
            const redirectUri = `${MCP_PUBLIC_URL}/oauth/callback`
            const authUrl     = buildOAuthAuthorizeUrl(state, redirectUri)
            const store       = requestContextStore.getStore()
            oauthStateMap.set(state, { sessionId: store?.sessionId || "__shared__", redirectUri })
            return responseJson({
                authenticated: false,
                method: "oauth2",
                authorize_url: authUrl,
                message: "Visit authorize_url in your browser to grant access, then call get_auth_status again."
            })
        }

        return responseJson({
            authenticated: false,
            method: "none",
            message: "Set REDMINE_API_KEY env var, or configure OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET + MCP_PUBLIC_URL."
        })
    }
)

defineTool(
    "set_api_key",
    "Manually set a Redmine API key for this session (fallback when OAuth is not configured).",
    {
        type: "object",
        properties: {
            api_key:  { type: "string" },
            username: { type: "string" }
        },
        required: ["api_key"]
    },
    async (args) => {
        const session = currentSession()
        session.apiKey       = asStringOrNull(args.api_key)
        session.username     = asStringOrNull(args.username)
        session.accessToken  = null
        session.refreshToken = null
        if (!session.apiKey) throw new Error("api_key cannot be blank")
        return responseText("API key stored for this MCP session.")
    }
)

// ---------------------------------------------------------------------------
// User / profile tools
// ---------------------------------------------------------------------------

defineTool(
    "get_my_profile",
    "Get current authenticated Redmine user profile.",
    { type: "object", properties: { include: { type: "string", description: "e.g. memberships,groups" } } },
    async (args) => {
        const response = await redmineRequest({ method: "get", path: "/users/current.json", params: { include: args.include } })
        // Cache username from profile
        const session = currentSession()
        if (response.data?.user?.login) session.username = response.data.user.login
        return responseFromRedmine(response, "Fetched current user profile.")
    }
)

defineTool(
    "redmine_api_request",
    "Generic Redmine REST API request for advanced/unsupported operations.",
    {
        type: "object",
        properties: {
            method:        { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
            path:          { type: "string", description: "API path, e.g. /issues.json" },
            query:         { type: "object", additionalProperties: true },
            body:          { type: "object", additionalProperties: true },
            requires_auth: { type: "boolean", default: true }
        },
        required: ["method", "path"]
    },
    async (args) => {
        const response = await redmineRequest({
            method: String(args.method).toLowerCase(),
            path: args.path,
            params: args.query,
            data: args.body,
            requiresAuth: args.requires_auth !== false
        })
        return responseFromRedmine(response, "Request completed.")
    }
)

// ---------------------------------------------------------------------------
// Metadata tools
// ---------------------------------------------------------------------------

defineTool("list_trackers",           "List Redmine issue trackers.",           { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/trackers.json" }), "Fetched trackers."))
defineTool("list_issue_statuses",     "List Redmine issue statuses.",           { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/issue_statuses.json" }), "Fetched statuses."))
defineTool("list_issue_priorities",   "List Redmine issue priorities.",         { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/enumerations/issue_priorities.json" }), "Fetched priorities."))
defineTool("list_time_entry_activities", "List Redmine time entry activities.", { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/enumerations/time_entry_activities.json" }), "Fetched activities."))
defineTool("list_roles",              "List Redmine roles.",                    { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/roles.json" }), "Fetched roles."))
defineTool("list_custom_fields",      "List Redmine custom fields.",            { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/custom_fields.json" }), "Fetched custom fields."))
defineTool("list_queries",            "List saved issue queries.",              { type: "object", properties: {} }, async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/queries.json" }), "Fetched queries."))

// ---------------------------------------------------------------------------
// Project tools
// ---------------------------------------------------------------------------

defineTool(
    "list_projects",
    "List projects visible to the authenticated user.",
    { type: "object", properties: { include: { type: "string" }, ...paginationProperties } },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "get", path: "/projects.json",
        params: { include: args.include, limit: args.limit || DEFAULT_LIMIT, offset: args.offset }
    }), "Fetched projects.")
)

defineTool(
    "get_project",
    "Get one project by identifier or numeric id.",
    { type: "object", properties: { id: idProperty, include: { type: "string" } }, required: ["id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args)))}.json`,
        params: { include: args.include }
    }), "Fetched project.")
)

defineTool(
    "create_project",
    "Create a new project (admin permission usually required).",
    {
        type: "object",
        properties: {
            name: { type: "string" }, identifier: { type: "string" },
            description: { type: "string" }, homepage: { type: "string" },
            is_public: { type: "boolean" }, parent_id: { type: ["integer", "string"] },
            inherit_members: { type: "boolean" },
            tracker_ids: { type: "array", items: { type: ["integer", "string"] } },
            enabled_module_names: { type: "array", items: { type: "string" } }
        },
        required: ["name", "identifier"]
    },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "post", path: "/projects.json",
        data: { project: compactObject({ name: args.name, identifier: args.identifier, description: args.description, homepage: args.homepage, is_public: args.is_public, parent_id: args.parent_id, inherit_members: args.inherit_members, tracker_ids: normalizeArray(args.tracker_ids), enabled_module_names: normalizeArray(args.enabled_module_names) }) }
    }), "Project created.")
)

defineTool(
    "update_project",
    "Update an existing project by identifier or numeric id.",
    {
        type: "object",
        properties: {
            id: idProperty, name: { type: "string" }, identifier: { type: "string" },
            description: { type: "string" }, homepage: { type: "string" },
            is_public: { type: "boolean" }, parent_id: { type: ["integer", "string"] },
            inherit_members: { type: "boolean" },
            tracker_ids: { type: "array", items: { type: ["integer", "string"] } },
            enabled_module_names: { type: "array", items: { type: "string" } }
        },
        required: ["id"]
    },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "put", path: `/projects/${encodeURIComponent(String(readResourceId(args)))}.json`,
        data: { project: compactObject({ name: args.name, identifier: args.identifier, description: args.description, homepage: args.homepage, is_public: args.is_public, parent_id: args.parent_id, inherit_members: args.inherit_members, tracker_ids: normalizeArray(args.tracker_ids), enabled_module_names: normalizeArray(args.enabled_module_names) }) }
    }), "Project updated.")
)

defineTool(
    "delete_project",
    "Delete a project by identifier or numeric id.",
    { type: "object", properties: { id: idProperty }, required: ["id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "delete", path: `/projects/${encodeURIComponent(String(readResourceId(args)))}.json`
    }), "Project deleted.")
)

// ---------------------------------------------------------------------------
// Issue tools
// ---------------------------------------------------------------------------

defineTool(
    "list_issues",
    "List issues with Redmine filters.",
    {
        type: "object",
        properties: {
            project_id: { type: ["string", "integer"] }, subproject_id: { type: ["string", "integer"] },
            tracker_id: { type: ["string", "integer"] }, status_id: { type: ["string", "integer"] },
            assigned_to_id: { type: ["string", "integer"] }, author_id: { type: ["string", "integer"] },
            query_id: { type: ["string", "integer"] }, priority_id: { type: ["string", "integer"] },
            category_id: { type: ["string", "integer"] }, fixed_version_id: { type: ["string", "integer"] },
            sort: { type: "string" }, created_on: { type: "string" }, updated_on: { type: "string" },
            include: { type: "string" }, ...paginationProperties
        }
    },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "get", path: "/issues.json",
        params: compactObject({ project_id: args.project_id, subproject_id: args.subproject_id, tracker_id: args.tracker_id, status_id: args.status_id, assigned_to_id: args.assigned_to_id, author_id: args.author_id, query_id: args.query_id, priority_id: args.priority_id, category_id: args.category_id, fixed_version_id: args.fixed_version_id, sort: args.sort, created_on: args.created_on, updated_on: args.updated_on, include: args.include, limit: args.limit || DEFAULT_LIMIT, offset: args.offset })
    }), "Fetched issues.")
)

defineTool(
    "get_issue",
    "Get a single issue by ID.",
    { type: "object", properties: { issue_id: { type: ["integer", "string"] }, include: { type: "string" } }, required: ["issue_id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "get", path: `/issues/${encodeURIComponent(String(readResourceId(args, "issue_id")))}.json`,
        params: { include: args.include }
    }), "Fetched issue.")
)

defineTool(
    "create_issue",
    "Create a Redmine issue.",
    {
        type: "object",
        properties: {
            project_id: { type: ["integer", "string"] }, subject: { type: "string" },
            description: { type: "string" }, tracker_id: { type: ["integer", "string"] },
            status_id: { type: ["integer", "string"] }, priority_id: { type: ["integer", "string"] },
            assigned_to_id: { type: ["integer", "string"] }, category_id: { type: ["integer", "string"] },
            fixed_version_id: { type: ["integer", "string"] }, parent_issue_id: { type: ["integer", "string"] },
            start_date: { type: "string" }, due_date: { type: "string" },
            estimated_hours: { type: "number" }, done_ratio: { type: "integer", minimum: 0, maximum: 100 },
            custom_fields: { type: "array", items: { type: "object", additionalProperties: true } },
            watcher_user_ids: { type: "array", items: { type: ["integer", "string"] } }
        },
        required: ["project_id", "subject"]
    },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "post", path: "/issues.json",
        data: { issue: compactObject({ project_id: args.project_id, subject: args.subject, description: args.description, tracker_id: args.tracker_id, status_id: args.status_id, priority_id: args.priority_id, assigned_to_id: args.assigned_to_id, category_id: args.category_id, fixed_version_id: args.fixed_version_id, parent_issue_id: args.parent_issue_id, start_date: args.start_date, due_date: args.due_date, estimated_hours: args.estimated_hours, done_ratio: args.done_ratio, custom_fields: normalizeArray(args.custom_fields), watcher_user_ids: normalizeArray(args.watcher_user_ids) }) }
    }), "Issue created.")
)

defineTool(
    "update_issue",
    "Update an issue by issue_id.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] }, subject: { type: "string" },
            description: { type: "string" }, tracker_id: { type: ["integer", "string"] },
            status_id: { type: ["integer", "string"] }, priority_id: { type: ["integer", "string"] },
            assigned_to_id: { type: ["integer", "string"] }, category_id: { type: ["integer", "string"] },
            fixed_version_id: { type: ["integer", "string"] }, parent_issue_id: { type: ["integer", "string"] },
            start_date: { type: "string" }, due_date: { type: "string" },
            estimated_hours: { type: "number" }, done_ratio: { type: "integer", minimum: 0, maximum: 100 },
            notes: { type: "string" }, private_notes: { type: "boolean" },
            custom_fields: { type: "array", items: { type: "object", additionalProperties: true } },
            watcher_user_ids: { type: "array", items: { type: ["integer", "string"] } }
        },
        required: ["issue_id"]
    },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "put", path: `/issues/${encodeURIComponent(String(readResourceId(args, "issue_id")))}.json`,
        data: { issue: compactObject({ subject: args.subject, description: args.description, tracker_id: args.tracker_id, status_id: args.status_id, priority_id: args.priority_id, assigned_to_id: args.assigned_to_id, category_id: args.category_id, fixed_version_id: args.fixed_version_id, parent_issue_id: args.parent_issue_id, start_date: args.start_date, due_date: args.due_date, estimated_hours: args.estimated_hours, done_ratio: args.done_ratio, notes: args.notes, private_notes: args.private_notes, custom_fields: normalizeArray(args.custom_fields), watcher_user_ids: normalizeArray(args.watcher_user_ids) }) }
    }), "Issue updated.")
)

defineTool(
    "add_issue_note",
    "Add a journal note/comment to an issue.",
    { type: "object", properties: { issue_id: { type: ["integer", "string"] }, notes: { type: "string" }, private_notes: { type: "boolean" } }, required: ["issue_id", "notes"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "put", path: `/issues/${encodeURIComponent(String(readResourceId(args, "issue_id")))}.json`,
        data: { issue: { notes: args.notes, private_notes: args.private_notes } }
    }), "Issue note added.")
)

defineTool(
    "delete_issue",
    "Delete an issue by ID.",
    { type: "object", properties: { issue_id: { type: ["integer", "string"] } }, required: ["issue_id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "delete", path: `/issues/${encodeURIComponent(String(readResourceId(args, "issue_id")))}.json`
    }), "Issue deleted.")
)

defineTool(
    "list_issue_relations",
    "List issue relations.",
    { type: "object", properties: { issue_id: { type: ["integer", "string"] } }, required: ["issue_id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "get", path: `/issues/${encodeURIComponent(String(readResourceId(args, "issue_id")))}/relations.json`
    }), "Fetched issue relations.")
)

defineTool(
    "create_issue_relation",
    "Create a relation between two issues.",
    { type: "object", properties: { issue_id: { type: ["integer", "string"] }, issue_to_id: { type: ["integer", "string"] }, relation_type: { type: "string" }, delay: { type: "integer" } }, required: ["issue_id", "issue_to_id", "relation_type"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "post", path: `/issues/${encodeURIComponent(String(readResourceId(args, "issue_id")))}/relations.json`,
        data: { relation: compactObject({ issue_to_id: args.issue_to_id, relation_type: args.relation_type, delay: args.delay }) }
    }), "Issue relation created.")
)

defineTool(
    "delete_issue_relation",
    "Delete an issue relation by relation_id.",
    { type: "object", properties: { relation_id: { type: ["integer", "string"] } }, required: ["relation_id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "delete", path: `/relations/${encodeURIComponent(String(readResourceId(args, "relation_id")))}.json`
    }), "Issue relation deleted.")
)

// ---------------------------------------------------------------------------
// Time entry tools
// ---------------------------------------------------------------------------

defineTool(
    "list_time_entries",
    "List time entries with optional filters.",
    { type: "object", properties: { project_id: { type: ["integer", "string"] }, issue_id: { type: ["integer", "string"] }, user_id: { type: ["integer", "string"] }, activity_id: { type: ["integer", "string"] }, from: { type: "string" }, to: { type: "string" }, spent_on: { type: "string" }, ...paginationProperties } },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "get", path: "/time_entries.json",
        params: compactObject({ project_id: args.project_id, issue_id: args.issue_id, user_id: args.user_id, activity_id: args.activity_id, from: args.from, to: args.to, spent_on: args.spent_on, limit: args.limit || DEFAULT_LIMIT, offset: args.offset })
    }), "Fetched time entries.")
)

defineTool(
    "get_time_entry",
    "Get one time entry by ID.",
    { type: "object", properties: { time_entry_id: { type: ["integer", "string"] } }, required: ["time_entry_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/time_entries/${encodeURIComponent(String(readResourceId(args, "time_entry_id")))}.json` }), "Fetched time entry.")
)

defineTool(
    "create_time_entry",
    "Create a time entry.",
    { type: "object", properties: { issue_id: { type: ["integer", "string"] }, project_id: { type: ["integer", "string"] }, spent_on: { type: "string" }, hours: { type: "number" }, activity_id: { type: ["integer", "string"] }, comments: { type: "string" }, user_id: { type: ["integer", "string"] }, custom_fields: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["hours"] },
    async (args) => {
        const te = compactObject({ issue_id: args.issue_id, project_id: args.project_id, spent_on: args.spent_on, hours: args.hours, activity_id: args.activity_id, comments: args.comments, user_id: args.user_id, custom_fields: normalizeArray(args.custom_fields) })
        if (!te.issue_id && !te.project_id) throw new Error("Either issue_id or project_id is required.")
        return responseFromRedmine(await redmineRequest({ method: "post", path: "/time_entries.json", data: { time_entry: te } }), "Time entry created.")
    }
)

defineTool(
    "update_time_entry",
    "Update a time entry by ID.",
    { type: "object", properties: { time_entry_id: { type: ["integer", "string"] }, issue_id: { type: ["integer", "string"] }, project_id: { type: ["integer", "string"] }, spent_on: { type: "string" }, hours: { type: "number" }, activity_id: { type: ["integer", "string"] }, comments: { type: "string" }, user_id: { type: ["integer", "string"] }, custom_fields: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["time_entry_id"] },
    async (args) => responseFromRedmine(await redmineRequest({
        method: "put", path: `/time_entries/${encodeURIComponent(String(readResourceId(args, "time_entry_id")))}.json`,
        data: { time_entry: compactObject({ issue_id: args.issue_id, project_id: args.project_id, spent_on: args.spent_on, hours: args.hours, activity_id: args.activity_id, comments: args.comments, user_id: args.user_id, custom_fields: normalizeArray(args.custom_fields) }) }
    }), "Time entry updated.")
)

defineTool(
    "delete_time_entry",
    "Delete a time entry by ID.",
    { type: "object", properties: { time_entry_id: { type: ["integer", "string"] } }, required: ["time_entry_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "delete", path: `/time_entries/${encodeURIComponent(String(readResourceId(args, "time_entry_id")))}.json` }), "Time entry deleted.")
)

// ---------------------------------------------------------------------------
// User & group tools
// ---------------------------------------------------------------------------

defineTool("list_users", "List users.", { type: "object", properties: { status: { type: "integer" }, name: { type: "string" }, group_id: { type: ["integer", "string"] }, ...paginationProperties } },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: "/users.json", params: compactObject({ status: args.status, name: args.name, group_id: args.group_id, limit: args.limit || DEFAULT_LIMIT, offset: args.offset }) }), "Fetched users."))

defineTool("get_user", "Get one user by ID.", { type: "object", properties: { user_id: { type: ["integer", "string"] }, include: { type: "string" } }, required: ["user_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/users/${encodeURIComponent(String(readResourceId(args, "user_id")))}.json`, params: { include: args.include } }), "Fetched user."))

defineTool("create_user", "Create user account (admin only).", { type: "object", properties: { login: { type: "string" }, firstname: { type: "string" }, lastname: { type: "string" }, mail: { type: "string" }, password: { type: "string" }, auth_source_id: { type: ["integer", "string"] }, generate_password: { type: "boolean" }, must_change_passwd: { type: "boolean" }, send_information: { type: "boolean" }, admin: { type: "boolean" } }, required: ["login", "firstname", "lastname", "mail"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "post", path: "/users.json", data: { user: compactObject({ login: args.login, firstname: args.firstname, lastname: args.lastname, mail: args.mail, password: args.password, auth_source_id: args.auth_source_id, generate_password: args.generate_password, must_change_passwd: args.must_change_passwd, send_information: args.send_information, admin: args.admin }) } }), "User created."))

defineTool("update_user", "Update user account (admin only).", { type: "object", properties: { user_id: { type: ["integer", "string"] }, login: { type: "string" }, firstname: { type: "string" }, lastname: { type: "string" }, mail: { type: "string" }, password: { type: "string" }, auth_source_id: { type: ["integer", "string"] }, generate_password: { type: "boolean" }, must_change_passwd: { type: "boolean" }, send_information: { type: "boolean" }, admin: { type: "boolean" } }, required: ["user_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "put", path: `/users/${encodeURIComponent(String(readResourceId(args, "user_id")))}.json`, data: { user: compactObject({ login: args.login, firstname: args.firstname, lastname: args.lastname, mail: args.mail, password: args.password, auth_source_id: args.auth_source_id, generate_password: args.generate_password, must_change_passwd: args.must_change_passwd, send_information: args.send_information, admin: args.admin }) } }), "User updated."))

defineTool("delete_user", "Delete a user account (admin only).", { type: "object", properties: { user_id: { type: ["integer", "string"] } }, required: ["user_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "delete", path: `/users/${encodeURIComponent(String(readResourceId(args, "user_id")))}.json` }), "User deleted."))

defineTool("list_groups", "List Redmine groups.", { type: "object", properties: { ...paginationProperties } },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: "/groups.json", params: { limit: args.limit || DEFAULT_LIMIT, offset: args.offset } }), "Fetched groups."))

defineTool("get_group", "Get one group by group_id.", { type: "object", properties: { group_id: { type: ["integer", "string"] }, include: { type: "string" } }, required: ["group_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/groups/${encodeURIComponent(String(readResourceId(args, "group_id")))}.json`, params: { include: args.include } }), "Fetched group."))

// ---------------------------------------------------------------------------
// Membership & version tools
// ---------------------------------------------------------------------------

defineTool("list_project_memberships", "List memberships for a project.", { type: "object", properties: { project_id: idProperty, ...paginationProperties }, required: ["project_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/memberships.json`, params: { limit: args.limit || DEFAULT_LIMIT, offset: args.offset } }), "Fetched memberships."))

defineTool("create_project_membership", "Create a project membership.", { type: "object", properties: { project_id: idProperty, user_id: { type: ["integer", "string"] }, role_ids: { type: "array", items: { type: ["integer", "string"] } } }, required: ["project_id", "user_id", "role_ids"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "post", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/memberships.json`, data: { membership: { user_id: args.user_id, role_ids: normalizeArray(args.role_ids) } } }), "Membership created."))

defineTool("update_membership", "Update membership roles.", { type: "object", properties: { membership_id: { type: ["integer", "string"] }, role_ids: { type: "array", items: { type: ["integer", "string"] } } }, required: ["membership_id", "role_ids"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "put", path: `/memberships/${encodeURIComponent(String(readResourceId(args, "membership_id")))}.json`, data: { membership: { role_ids: normalizeArray(args.role_ids) } } }), "Membership updated."))

defineTool("delete_membership", "Delete membership.", { type: "object", properties: { membership_id: { type: ["integer", "string"] } }, required: ["membership_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "delete", path: `/memberships/${encodeURIComponent(String(readResourceId(args, "membership_id")))}.json` }), "Membership deleted."))

defineTool("list_project_versions", "List versions in a project.", { type: "object", properties: { project_id: idProperty, status: { type: "string" }, ...paginationProperties }, required: ["project_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/versions.json`, params: compactObject({ status: args.status, limit: args.limit || DEFAULT_LIMIT, offset: args.offset }) }), "Fetched versions."))

defineTool("create_project_version", "Create a version in a project.", { type: "object", properties: { project_id: idProperty, name: { type: "string" }, description: { type: "string" }, status: { type: "string" }, sharing: { type: "string" }, due_date: { type: "string" }, wiki_page_title: { type: "string" } }, required: ["project_id", "name"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "post", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/versions.json`, data: { version: compactObject({ name: args.name, description: args.description, status: args.status, sharing: args.sharing, due_date: args.due_date, wiki_page_title: args.wiki_page_title }) } }), "Version created."))

defineTool("update_version", "Update a version.", { type: "object", properties: { version_id: { type: ["integer", "string"] }, name: { type: "string" }, description: { type: "string" }, status: { type: "string" }, sharing: { type: "string" }, due_date: { type: "string" }, wiki_page_title: { type: "string" } }, required: ["version_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "put", path: `/versions/${encodeURIComponent(String(readResourceId(args, "version_id")))}.json`, data: { version: compactObject({ name: args.name, description: args.description, status: args.status, sharing: args.sharing, due_date: args.due_date, wiki_page_title: args.wiki_page_title }) } }), "Version updated."))

defineTool("delete_version", "Delete a version.", { type: "object", properties: { version_id: { type: ["integer", "string"] } }, required: ["version_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "delete", path: `/versions/${encodeURIComponent(String(readResourceId(args, "version_id")))}.json` }), "Version deleted."))

// ---------------------------------------------------------------------------
// Project content tools
// ---------------------------------------------------------------------------

defineTool("list_project_news",      "List project news.",      { type: "object", properties: { project_id: idProperty, ...paginationProperties }, required: ["project_id"] }, async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/news.json`, params: { limit: args.limit || DEFAULT_LIMIT, offset: args.offset } }), "Fetched news."))
defineTool("list_project_files",     "List project files.",     { type: "object", properties: { project_id: idProperty }, required: ["project_id"] }, async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/files.json` }), "Fetched files."))
defineTool("list_project_documents", "List project documents.", { type: "object", properties: { project_id: idProperty }, required: ["project_id"] }, async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/documents.json` }), "Fetched documents."))

// ---------------------------------------------------------------------------
// Wiki tools
// ---------------------------------------------------------------------------

defineTool("list_wiki_pages", "List wiki pages in a project.", { type: "object", properties: { project_id: idProperty }, required: ["project_id"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/wiki/index.json` }), "Fetched wiki index."))

defineTool("get_wiki_page", "Get one wiki page by title.", { type: "object", properties: { project_id: idProperty, title: { type: "string" }, version: { type: ["integer", "string"] }, include: { type: "string" } }, required: ["project_id", "title"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "get", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/wiki/${encodeWikiTitle(args.title)}.json`, params: { version: args.version, include: args.include } }), "Fetched wiki page."))

defineTool("update_wiki_page", "Create or update wiki page content.", { type: "object", properties: { project_id: idProperty, title: { type: "string" }, text: { type: "string" }, comments: { type: "string" }, version: { type: ["integer", "string"] } }, required: ["project_id", "title", "text"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "put", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/wiki/${encodeWikiTitle(args.title)}.json`, data: { wiki_page: compactObject({ text: args.text, comments: args.comments, version: args.version }) } }), "Wiki page updated."))

defineTool("delete_wiki_page", "Delete a wiki page.", { type: "object", properties: { project_id: idProperty, title: { type: "string" } }, required: ["project_id", "title"] },
    async (args) => responseFromRedmine(await redmineRequest({ method: "delete", path: `/projects/${encodeURIComponent(String(readResourceId(args, "project_id")))}/wiki/${encodeWikiTitle(args.title)}.json` }), "Wiki page deleted."))

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createServerInstance() {
    const server = new Server(
        { name: "redmineflux-mcp", version: "2.0.0" },
        { capabilities: { tools: {} } }
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args = {} } = request.params
        const tool = tools.find(t => t.name === name)
        if (!tool) throw new Error(`Unknown tool: ${name}`)

        return await requestContextStore.run(extra || {}, async () => {
            try {
                return await tool.handler(args, extra)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[redmineflux-mcp] ${name} failed: ${message}`)
                return responseJson({ ok: false, error: message, tool: name })
            }
        })
    })

    return server
}

// ---------------------------------------------------------------------------
// HTTP session helpers
// ---------------------------------------------------------------------------

function extractSessionIdHeader(req) {
    const raw = req.headers["mcp-session-id"]
    return Array.isArray(raw) ? raw[0] : (typeof raw === "string" ? raw : undefined)
}

function sendJsonRpcError(res, status, message, code = -32000) {
    res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null })
}

async function createHttpSession(sessions) {
    const server = createServerInstance()
    let createdSessionId = null

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
            createdSessionId = sessionId
            sessions.set(sessionId, { transport, server })
        }
    })

    transport.onclose = () => {
        if (createdSessionId) {
            sessions.delete(createdSessionId)
            sessionStates.delete(createdSessionId)
        }
    }

    await server.connect(transport)
    return transport
}

// ---------------------------------------------------------------------------
// Transport: stdio
// ---------------------------------------------------------------------------

async function startStdio() {
    const server = createServerInstance()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error(`[redmineflux-mcp] Ready with ${tools.length} tools (stdio).`)
}

// ---------------------------------------------------------------------------
// Transport: HTTP  +  OAuth 2.0 callback routes
// ---------------------------------------------------------------------------

async function startHttp() {
    const app = await createMcpExpressApp({ host: HTTP_HOST })
    const sessions = new Map()

    // ------------------------------------------------------------------
    // OAuth 2.0 discovery endpoint
    // Claude's MCP connector reads this to find the auth + token URLs.
    // ------------------------------------------------------------------
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
        if (!OAUTH_CLIENT_ID) {
            return res.status(404).json({ error: "OAuth not configured on this server." })
        }
        res.json({
            issuer:                                REDMINE_URL,
            authorization_endpoint:                OAUTH_AUTHORIZE_URL,
            token_endpoint:                        OAUTH_TOKEN_URL,
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            response_types_supported:              ["code"],
            grant_types_supported:                 ["authorization_code", "refresh_token"],
            scopes_supported:                      ["api"],
            code_challenge_methods_supported:      ["S256"]
        })
    })

    // ------------------------------------------------------------------
    // OAuth 2.0 callback — Redmine redirects here after user approves
    // ------------------------------------------------------------------
    app.get("/oauth/callback", async (req, res) => {
        const { code, state, error } = req.query

        if (error) {
            return res.status(400).send(`<h2>Authorization denied</h2><p>${error}</p>`)
        }

        if (!code || !state) {
            return res.status(400).send("<h2>Invalid callback — missing code or state.</h2>")
        }

        const pending = oauthStateMap.get(state)
        if (!pending) {
            return res.status(400).send("<h2>Unknown or expired OAuth state. Please try again.</h2>")
        }

        oauthStateMap.delete(state)

        try {
            const tokenData = await exchangeCodeForTokens(code, `${MCP_PUBLIC_URL}/oauth/callback`)
            const session   = sessionStates.get(pending.sessionId) || createSessionState()
            applyTokenResponse(session, tokenData)
            sessionStates.set(pending.sessionId, session)

            // Try to hydrate username from Redmine
            try {
                const profileRes = await redmineClient.get(`${REDMINE_URL}/users/current.json`, {
                    headers: { Authorization: `Bearer ${session.accessToken}`, Accept: "application/json" }
                })
                if (profileRes.data?.user?.login) session.username = profileRes.data.user.login
            } catch (_) { /* non-fatal */ }

            res.send(`
                <html><body style="font-family:sans-serif;padding:2rem">
                <h2>Authorization successful!</h2>
                <p>You are now connected to Redmine as <strong>${session.username || "unknown"}</strong>.</p>
                <p>You can close this tab and return to Claude.</p>
                </body></html>
            `)
        } catch (err) {
            console.error("[redmineflux-mcp] OAuth callback error:", err.message)
            res.status(500).send(`<h2>Token exchange failed</h2><p>${err.message}</p>`)
        }
    })

    // ------------------------------------------------------------------
    // Health check
    // ------------------------------------------------------------------
    app.get("/health", (_req, res) => {
        res.json({
            ok: true,
            name: "redmineflux-mcp",
            version: "2.0.0",
            mode: "http",
            redmine_url: REDMINE_URL,
            oauth_configured: !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET)
        })
    })

    // ------------------------------------------------------------------
    // MCP endpoint
    // ------------------------------------------------------------------
    app.all(HTTP_PATH, async (req, res) => {
        try {
            if (req.method === "POST" && !req.is("application/json")) {
                return sendJsonRpcError(res, 415, "Unsupported content type. Use application/json.")
            }

            const sessionId = extractSessionIdHeader(req)
            let transport

            if (sessionId) {
                const existing = sessions.get(sessionId)
                if (!existing) return sendJsonRpcError(res, 404, "Session not found")
                transport = existing.transport
            } else {
                if (!(req.method === "POST" && isInitializeRequest(req.body))) {
                    return sendJsonRpcError(res, 400, "No valid session ID provided")
                }
                transport = await createHttpSession(sessions)
            }

            await transport.handleRequest(req, res, req.body)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[redmineflux-mcp] HTTP transport error: ${message}`)
            if (!res.headersSent) sendJsonRpcError(res, 500, "Internal server error", -32603)
        }
    })

    // ------------------------------------------------------------------
    // Optional Redmine proxy
    // ------------------------------------------------------------------
    if (REDMINE_PROXY_URL) {
        console.error(`[redmineflux-mcp] Proxy → ${REDMINE_PROXY_URL}`)
        app.use("/", createProxyMiddleware({
            target: REDMINE_PROXY_URL,
            changeOrigin: true, ws: true, xfwd: true,
            proxyTimeout: REQUEST_TIMEOUT_MS,
            onError: (err, _req, res) => {
                if (!res.headersSent) res.status(502).json({ error: "bad_gateway", message: err.message })
            }
        }))
    }

    await new Promise((resolve, reject) => {
        const listener = app.listen(HTTP_PORT, HTTP_HOST, () => {
            console.error(`[redmineflux-mcp] Ready with ${tools.length} tools (http) on ${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}`)
            resolve()
        })
        listener.on("error", reject)
    })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function start() {
    if (TRANSPORT_MODE === "http" || TRANSPORT_MODE === "streamable-http") {
        await startHttp()
    } else {
        await startStdio()
    }
}

start().catch(error => {
    console.error(`[redmineflux-mcp] Fatal: ${error.message}`)
    process.exit(1)
})