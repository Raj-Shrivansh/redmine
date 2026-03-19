import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import axios from "axios"

const REDMINE_URL = normalizeBaseUrl(process.env.REDMINE_URL || "http://127.0.0.1:3000")
const LOGIN_PATH = process.env.REDMINE_MCP_LOGIN_PATH || "/mcp/auth/login"
const REQUEST_TIMEOUT_MS = toPositiveInteger(process.env.REDMINE_TIMEOUT_MS, 20000)
const DEFAULT_LIMIT = toPositiveInteger(process.env.REDMINE_DEFAULT_LIMIT, 25)

const session = {
    apiKey: asStringOrNull(process.env.REDMINE_API_KEY),
    username: asStringOrNull(process.env.REDMINE_USERNAME),
    accessToken: null,
    autoLoginAttempted: false
}

const redmineClient = axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true
})

console.error(`[redmineflux-mcp] Starting MCP server for ${REDMINE_URL}`)
if (session.apiKey) {
    console.error("[redmineflux-mcp] Auth mode: REDMINE_API_KEY")
} else if (session.username && process.env.REDMINE_PASSWORD) {
    console.error("[redmineflux-mcp] Auth mode: REDMINE_USERNAME/REDMINE_PASSWORD (auto login)")
} else {
    console.error("[redmineflux-mcp] Auth mode: interactive login_redmine or set REDMINE_API_KEY")
}

const server = new Server(
    {
        name: "redmineflux-mcp",
        version: "1.1.0"
    },
    {
        capabilities: { tools: {} }
    }
)

const tools = []

function defineTool(name, description, inputSchema, handler) {
    tools.push({ name, description, inputSchema, handler })
}

function asStringOrNull(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
}

function normalizeBaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "")
}

function toPositiveInteger(value, fallbackValue) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue
}

function compactObject(obj = {}) {
    const entries = Object.entries(obj).filter(([, value]) => {
        if (value === undefined || value === null) return false
        if (typeof value === "string" && value.trim() === "") return false
        return true
    })
    return Object.fromEntries(entries)
}

function normalizeArray(value) {
    if (value === undefined || value === null) return undefined
    if (Array.isArray(value)) return value
    return [value]
}

function encodeWikiTitle(title) {
    return String(title)
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")
}

function responseText(text) {
    return {
        content: [{ type: "text", text }]
    }
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

function buildAuthHeaders() {
    const headers = { Accept: "application/json" }
    if (session.apiKey) {
        headers["X-Redmine-API-Key"] = session.apiKey
    }
    return headers
}

async function loginWithCredentials(username, password) {
    const url = `${REDMINE_URL}${LOGIN_PATH.startsWith("/") ? LOGIN_PATH : `/${LOGIN_PATH}`}`
    const response = await redmineClient.post(url, { username, password }, {
        headers: { "Content-Type": "application/json", Accept: "application/json" }
    })

    if (response.status >= 400) {
        throw new Error(`Login failed: ${extractErrorMessage(response)}`)
    }

    const apiKey = asStringOrNull(response.data?.redmine_api_key)
    if (!apiKey) {
        throw new Error("Login response did not include redmine_api_key")
    }

    session.apiKey = apiKey
    session.accessToken = asStringOrNull(response.data?.access_token)
    session.username = username
}

async function ensureAuthenticated() {
    if (session.apiKey) return

    if (!session.autoLoginAttempted) {
        session.autoLoginAttempted = true
        const username = asStringOrNull(process.env.REDMINE_USERNAME)
        const password = asStringOrNull(process.env.REDMINE_PASSWORD)
        if (username && password) {
            await loginWithCredentials(username, password)
            return
        }
    }

    throw new Error("Not authenticated. Set REDMINE_API_KEY in Claude config or call login_redmine first.")
}

async function redmineRequest({ method, path, params, data, requiresAuth = true }) {
    if (requiresAuth) {
        await ensureAuthenticated()
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    const url = `${REDMINE_URL}${normalizedPath}`

    const response = await redmineClient.request({
        method,
        url,
        params: compactObject(params),
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
    if (body !== undefined && body !== null && body !== "") {
        return responseJson(body)
    }

    return responseJson({
        ok: true,
        status: response.status,
        message: successMessage
    })
}

function readResourceId(args, key = "id") {
    const value = args[key]
    if (value === undefined || value === null || String(value).trim() === "") {
        throw new Error(`Missing required argument: ${key}`)
    }
    return value
}

const idProperty = {
    type: ["string", "integer"],
    description: "Numeric ID or identifier"
}

const paginationProperties = {
    limit: {
        type: "integer",
        minimum: 1,
        default: DEFAULT_LIMIT,
        description: "Page size"
    },
    offset: {
        type: "integer",
        minimum: 0,
        description: "Offset for pagination"
    }
}

defineTool(
    "login_redmine",
    "Authenticate against /mcp/auth/login using Redmine username/password and store API key in session.",
    {
        type: "object",
        properties: {
            username: { type: "string" },
            password: { type: "string" }
        },
        required: ["username", "password"]
    },
    async (args) => {
        await loginWithCredentials(args.username, args.password)
        return responseText(`Authenticated as ${session.username}. API key is now active for this MCP session.`)
    }
)

defineTool(
    "set_api_key",
    "Set/replace the active Redmine API key for this MCP session.",
    {
        type: "object",
        properties: {
            api_key: { type: "string" },
            username: { type: "string" }
        },
        required: ["api_key"]
    },
    async (args) => {
        session.apiKey = asStringOrNull(args.api_key)
        session.username = asStringOrNull(args.username)
        session.accessToken = null
        if (!session.apiKey) {
            throw new Error("api_key cannot be blank")
        }
        return responseText("API key has been stored for this MCP session.")
    }
)

defineTool(
    "get_my_profile",
    "Get current authenticated Redmine user profile.",
    {
        type: "object",
        properties: {
            include: {
                type: "string",
                description: "Optional includes, e.g. memberships,groups"
            }
        }
    },
    async (args) => {
        const response = await redmineRequest({
            method: "get",
            path: "/users/current.json",
            params: { include: args.include }
        })
        return responseFromRedmine(response, "Fetched current user profile.")
    }
)

defineTool(
    "redmine_api_request",
    "Generic Redmine REST API request for advanced/unsupported operations.",
    {
        type: "object",
        properties: {
            method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "DELETE", "PATCH"]
            },
            path: {
                type: "string",
                description: "API path like /issues.json"
            },
            query: {
                type: "object",
                additionalProperties: true
            },
            body: {
                type: "object",
                additionalProperties: true
            },
            requires_auth: {
                type: "boolean",
                default: true
            }
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

// Metadata tools

defineTool(
    "list_trackers",
    "List Redmine issue trackers.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/trackers.json" }), "Fetched trackers.")
)

defineTool(
    "list_issue_statuses",
    "List Redmine issue statuses.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/issue_statuses.json" }), "Fetched statuses.")
)

defineTool(
    "list_issue_priorities",
    "List Redmine issue priorities.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/enumerations/issue_priorities.json" }), "Fetched priorities.")
)

defineTool(
    "list_time_entry_activities",
    "List Redmine time entry activities.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/enumerations/time_entry_activities.json" }), "Fetched activities.")
)

defineTool(
    "list_roles",
    "List Redmine roles.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/roles.json" }), "Fetched roles.")
)

defineTool(
    "list_custom_fields",
    "List Redmine custom fields.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/custom_fields.json" }), "Fetched custom fields.")
)

defineTool(
    "list_queries",
    "List saved issue queries.",
    { type: "object", properties: {} },
    async () => responseFromRedmine(await redmineRequest({ method: "get", path: "/queries.json" }), "Fetched queries.")
)

// Project tools

defineTool(
    "list_projects",
    "List projects visible to the authenticated user.",
    {
        type: "object",
        properties: {
            include: { type: "string", description: "Optional includes, e.g. trackers,issue_categories,enabled_modules" },
            ...paginationProperties
        }
    },
    async (args) => {
        const response = await redmineRequest({
            method: "get",
            path: "/projects.json",
            params: {
                include: args.include,
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })
        return responseFromRedmine(response, "Fetched projects.")
    }
)

defineTool(
    "get_project",
    "Get one project by identifier or numeric id.",
    {
        type: "object",
        properties: {
            id: idProperty,
            include: { type: "string", description: "Optional includes, e.g. trackers,issue_categories,enabled_modules,time_entry_activities,issue_custom_fields" }
        },
        required: ["id"]
    },
    async (args) => {
        const id = readResourceId(args)
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(id))}.json`,
            params: { include: args.include }
        })
        return responseFromRedmine(response, "Fetched project.")
    }
)

defineTool(
    "create_project",
    "Create a new project (admin permission usually required).",
    {
        type: "object",
        properties: {
            name: { type: "string" },
            identifier: { type: "string" },
            description: { type: "string" },
            homepage: { type: "string" },
            is_public: { type: "boolean" },
            parent_id: { type: ["integer", "string"] },
            inherit_members: { type: "boolean" },
            tracker_ids: { type: "array", items: { type: ["integer", "string"] } },
            enabled_module_names: { type: "array", items: { type: "string" } }
        },
        required: ["name", "identifier"]
    },
    async (args) => {
        const project = compactObject({
            name: args.name,
            identifier: args.identifier,
            description: args.description,
            homepage: args.homepage,
            is_public: args.is_public,
            parent_id: args.parent_id,
            inherit_members: args.inherit_members,
            tracker_ids: normalizeArray(args.tracker_ids),
            enabled_module_names: normalizeArray(args.enabled_module_names)
        })

        const response = await redmineRequest({
            method: "post",
            path: "/projects.json",
            data: { project }
        })

        return responseFromRedmine(response, "Project created.")
    }
)

defineTool(
    "update_project",
    "Update an existing project by identifier or numeric id.",
    {
        type: "object",
        properties: {
            id: idProperty,
            name: { type: "string" },
            identifier: { type: "string" },
            description: { type: "string" },
            homepage: { type: "string" },
            is_public: { type: "boolean" },
            parent_id: { type: ["integer", "string"] },
            inherit_members: { type: "boolean" },
            tracker_ids: { type: "array", items: { type: ["integer", "string"] } },
            enabled_module_names: { type: "array", items: { type: "string" } }
        },
        required: ["id"]
    },
    async (args) => {
        const id = readResourceId(args)
        const project = compactObject({
            name: args.name,
            identifier: args.identifier,
            description: args.description,
            homepage: args.homepage,
            is_public: args.is_public,
            parent_id: args.parent_id,
            inherit_members: args.inherit_members,
            tracker_ids: normalizeArray(args.tracker_ids),
            enabled_module_names: normalizeArray(args.enabled_module_names)
        })

        const response = await redmineRequest({
            method: "put",
            path: `/projects/${encodeURIComponent(String(id))}.json`,
            data: { project }
        })

        return responseFromRedmine(response, "Project updated.")
    }
)

defineTool(
    "delete_project",
    "Delete a project by identifier or numeric id.",
    {
        type: "object",
        properties: {
            id: idProperty
        },
        required: ["id"]
    },
    async (args) => {
        const id = readResourceId(args)
        const response = await redmineRequest({
            method: "delete",
            path: `/projects/${encodeURIComponent(String(id))}.json`
        })
        return responseFromRedmine(response, "Project deleted.")
    }
)

// Issue tools

defineTool(
    "list_issues",
    "List issues with Redmine filters.",
    {
        type: "object",
        properties: {
            project_id: { type: ["string", "integer"] },
            subproject_id: { type: ["string", "integer"] },
            tracker_id: { type: ["string", "integer"] },
            status_id: { type: ["string", "integer"] },
            assigned_to_id: { type: ["string", "integer"] },
            author_id: { type: ["string", "integer"] },
            query_id: { type: ["string", "integer"] },
            priority_id: { type: ["string", "integer"] },
            category_id: { type: ["string", "integer"] },
            fixed_version_id: { type: ["string", "integer"] },
            sort: { type: "string", description: "Sort expression like 'updated_on:desc'" },
            created_on: { type: "string" },
            updated_on: { type: "string" },
            include: { type: "string", description: "Optional includes, e.g. attachments,relations" },
            ...paginationProperties
        }
    },
    async (args) => {
        const response = await redmineRequest({
            method: "get",
            path: "/issues.json",
            params: {
                project_id: args.project_id,
                subproject_id: args.subproject_id,
                tracker_id: args.tracker_id,
                status_id: args.status_id,
                assigned_to_id: args.assigned_to_id,
                author_id: args.author_id,
                query_id: args.query_id,
                priority_id: args.priority_id,
                category_id: args.category_id,
                fixed_version_id: args.fixed_version_id,
                sort: args.sort,
                created_on: args.created_on,
                updated_on: args.updated_on,
                include: args.include,
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })
        return responseFromRedmine(response, "Fetched issues.")
    }
)

defineTool(
    "get_issue",
    "Get a single issue by ID.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] },
            include: { type: "string", description: "Optional includes, e.g. children,attachments,relations,changesets,journals,watchers,allowed_statuses" }
        },
        required: ["issue_id"]
    },
    async (args) => {
        const issueId = readResourceId(args, "issue_id")
        const response = await redmineRequest({
            method: "get",
            path: `/issues/${encodeURIComponent(String(issueId))}.json`,
            params: { include: args.include }
        })
        return responseFromRedmine(response, "Fetched issue.")
    }
)

defineTool(
    "create_issue",
    "Create a Redmine issue.",
    {
        type: "object",
        properties: {
            project_id: { type: ["integer", "string"] },
            subject: { type: "string" },
            description: { type: "string" },
            tracker_id: { type: ["integer", "string"] },
            status_id: { type: ["integer", "string"] },
            priority_id: { type: ["integer", "string"] },
            assigned_to_id: { type: ["integer", "string"] },
            category_id: { type: ["integer", "string"] },
            fixed_version_id: { type: ["integer", "string"] },
            parent_issue_id: { type: ["integer", "string"] },
            start_date: { type: "string", description: "YYYY-MM-DD" },
            due_date: { type: "string", description: "YYYY-MM-DD" },
            estimated_hours: { type: "number" },
            done_ratio: { type: "integer", minimum: 0, maximum: 100 },
            custom_fields: { type: "array", items: { type: "object", additionalProperties: true } },
            watcher_user_ids: { type: "array", items: { type: ["integer", "string"] } }
        },
        required: ["project_id", "subject"]
    },
    async (args) => {
        const issue = compactObject({
            project_id: args.project_id,
            subject: args.subject,
            description: args.description,
            tracker_id: args.tracker_id,
            status_id: args.status_id,
            priority_id: args.priority_id,
            assigned_to_id: args.assigned_to_id,
            category_id: args.category_id,
            fixed_version_id: args.fixed_version_id,
            parent_issue_id: args.parent_issue_id,
            start_date: args.start_date,
            due_date: args.due_date,
            estimated_hours: args.estimated_hours,
            done_ratio: args.done_ratio,
            custom_fields: normalizeArray(args.custom_fields),
            watcher_user_ids: normalizeArray(args.watcher_user_ids)
        })

        const response = await redmineRequest({
            method: "post",
            path: "/issues.json",
            data: { issue }
        })

        return responseFromRedmine(response, "Issue created.")
    }
)

defineTool(
    "update_issue",
    "Update an issue by issue_id.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] },
            subject: { type: "string" },
            description: { type: "string" },
            tracker_id: { type: ["integer", "string"] },
            status_id: { type: ["integer", "string"] },
            priority_id: { type: ["integer", "string"] },
            assigned_to_id: { type: ["integer", "string"] },
            category_id: { type: ["integer", "string"] },
            fixed_version_id: { type: ["integer", "string"] },
            parent_issue_id: { type: ["integer", "string"] },
            start_date: { type: "string" },
            due_date: { type: "string" },
            estimated_hours: { type: "number" },
            done_ratio: { type: "integer", minimum: 0, maximum: 100 },
            notes: { type: "string" },
            private_notes: { type: "boolean" },
            custom_fields: { type: "array", items: { type: "object", additionalProperties: true } },
            watcher_user_ids: { type: "array", items: { type: ["integer", "string"] } }
        },
        required: ["issue_id"]
    },
    async (args) => {
        const issueId = readResourceId(args, "issue_id")
        const issue = compactObject({
            subject: args.subject,
            description: args.description,
            tracker_id: args.tracker_id,
            status_id: args.status_id,
            priority_id: args.priority_id,
            assigned_to_id: args.assigned_to_id,
            category_id: args.category_id,
            fixed_version_id: args.fixed_version_id,
            parent_issue_id: args.parent_issue_id,
            start_date: args.start_date,
            due_date: args.due_date,
            estimated_hours: args.estimated_hours,
            done_ratio: args.done_ratio,
            notes: args.notes,
            private_notes: args.private_notes,
            custom_fields: normalizeArray(args.custom_fields),
            watcher_user_ids: normalizeArray(args.watcher_user_ids)
        })

        const response = await redmineRequest({
            method: "put",
            path: `/issues/${encodeURIComponent(String(issueId))}.json`,
            data: { issue }
        })

        return responseFromRedmine(response, "Issue updated.")
    }
)

defineTool(
    "add_issue_note",
    "Add a journal note/comment to an issue.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] },
            notes: { type: "string" },
            private_notes: { type: "boolean" }
        },
        required: ["issue_id", "notes"]
    },
    async (args) => {
        const issueId = readResourceId(args, "issue_id")
        const response = await redmineRequest({
            method: "put",
            path: `/issues/${encodeURIComponent(String(issueId))}.json`,
            data: { issue: { notes: args.notes, private_notes: args.private_notes } }
        })

        return responseFromRedmine(response, "Issue note added.")
    }
)

defineTool(
    "delete_issue",
    "Delete an issue by ID.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] }
        },
        required: ["issue_id"]
    },
    async (args) => {
        const issueId = readResourceId(args, "issue_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/issues/${encodeURIComponent(String(issueId))}.json`
        })

        return responseFromRedmine(response, "Issue deleted.")
    }
)

defineTool(
    "list_issue_relations",
    "List issue relations for an issue.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] }
        },
        required: ["issue_id"]
    },
    async (args) => {
        const issueId = readResourceId(args, "issue_id")
        const response = await redmineRequest({
            method: "get",
            path: `/issues/${encodeURIComponent(String(issueId))}/relations.json`
        })
        return responseFromRedmine(response, "Fetched issue relations.")
    }
)

defineTool(
    "create_issue_relation",
    "Create a relation between two issues.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] },
            issue_to_id: { type: ["integer", "string"] },
            relation_type: { type: "string", description: "relates, duplicates, duplicated, blocks, precedes, follows, copied_to, copied_from" },
            delay: { type: "integer" }
        },
        required: ["issue_id", "issue_to_id", "relation_type"]
    },
    async (args) => {
        const issueId = readResourceId(args, "issue_id")
        const relation = compactObject({
            issue_to_id: args.issue_to_id,
            relation_type: args.relation_type,
            delay: args.delay
        })

        const response = await redmineRequest({
            method: "post",
            path: `/issues/${encodeURIComponent(String(issueId))}/relations.json`,
            data: { relation }
        })

        return responseFromRedmine(response, "Issue relation created.")
    }
)

defineTool(
    "delete_issue_relation",
    "Delete an issue relation by relation_id.",
    {
        type: "object",
        properties: {
            relation_id: { type: ["integer", "string"] }
        },
        required: ["relation_id"]
    },
    async (args) => {
        const relationId = readResourceId(args, "relation_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/relations/${encodeURIComponent(String(relationId))}.json`
        })

        return responseFromRedmine(response, "Issue relation deleted.")
    }
)

// Time entry tools

defineTool(
    "list_time_entries",
    "List time entries with optional filters.",
    {
        type: "object",
        properties: {
            project_id: { type: ["integer", "string"] },
            issue_id: { type: ["integer", "string"] },
            user_id: { type: ["integer", "string"] },
            activity_id: { type: ["integer", "string"] },
            from: { type: "string", description: "Start date YYYY-MM-DD" },
            to: { type: "string", description: "End date YYYY-MM-DD" },
            spent_on: { type: "string", description: "Date YYYY-MM-DD" },
            ...paginationProperties
        }
    },
    async (args) => {
        const response = await redmineRequest({
            method: "get",
            path: "/time_entries.json",
            params: {
                project_id: args.project_id,
                issue_id: args.issue_id,
                user_id: args.user_id,
                activity_id: args.activity_id,
                from: args.from,
                to: args.to,
                spent_on: args.spent_on,
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })

        return responseFromRedmine(response, "Fetched time entries.")
    }
)

defineTool(
    "get_time_entry",
    "Get one time entry by ID.",
    {
        type: "object",
        properties: {
            time_entry_id: { type: ["integer", "string"] }
        },
        required: ["time_entry_id"]
    },
    async (args) => {
        const timeEntryId = readResourceId(args, "time_entry_id")
        const response = await redmineRequest({
            method: "get",
            path: `/time_entries/${encodeURIComponent(String(timeEntryId))}.json`
        })

        return responseFromRedmine(response, "Fetched time entry.")
    }
)

defineTool(
    "create_time_entry",
    "Create a time entry.",
    {
        type: "object",
        properties: {
            issue_id: { type: ["integer", "string"] },
            project_id: { type: ["integer", "string"] },
            spent_on: { type: "string", description: "YYYY-MM-DD" },
            hours: { type: "number" },
            activity_id: { type: ["integer", "string"] },
            comments: { type: "string" },
            user_id: { type: ["integer", "string"] },
            custom_fields: { type: "array", items: { type: "object", additionalProperties: true } }
        },
        required: ["hours"]
    },
    async (args) => {
        const timeEntry = compactObject({
            issue_id: args.issue_id,
            project_id: args.project_id,
            spent_on: args.spent_on,
            hours: args.hours,
            activity_id: args.activity_id,
            comments: args.comments,
            user_id: args.user_id,
            custom_fields: normalizeArray(args.custom_fields)
        })

        if (!timeEntry.issue_id && !timeEntry.project_id) {
            throw new Error("Either issue_id or project_id is required for a time entry.")
        }

        const response = await redmineRequest({
            method: "post",
            path: "/time_entries.json",
            data: { time_entry: timeEntry }
        })

        return responseFromRedmine(response, "Time entry created.")
    }
)

defineTool(
    "update_time_entry",
    "Update a time entry by ID.",
    {
        type: "object",
        properties: {
            time_entry_id: { type: ["integer", "string"] },
            issue_id: { type: ["integer", "string"] },
            project_id: { type: ["integer", "string"] },
            spent_on: { type: "string" },
            hours: { type: "number" },
            activity_id: { type: ["integer", "string"] },
            comments: { type: "string" },
            user_id: { type: ["integer", "string"] },
            custom_fields: { type: "array", items: { type: "object", additionalProperties: true } }
        },
        required: ["time_entry_id"]
    },
    async (args) => {
        const timeEntryId = readResourceId(args, "time_entry_id")
        const timeEntry = compactObject({
            issue_id: args.issue_id,
            project_id: args.project_id,
            spent_on: args.spent_on,
            hours: args.hours,
            activity_id: args.activity_id,
            comments: args.comments,
            user_id: args.user_id,
            custom_fields: normalizeArray(args.custom_fields)
        })

        const response = await redmineRequest({
            method: "put",
            path: `/time_entries/${encodeURIComponent(String(timeEntryId))}.json`,
            data: { time_entry: timeEntry }
        })

        return responseFromRedmine(response, "Time entry updated.")
    }
)

defineTool(
    "delete_time_entry",
    "Delete a time entry by ID.",
    {
        type: "object",
        properties: {
            time_entry_id: { type: ["integer", "string"] }
        },
        required: ["time_entry_id"]
    },
    async (args) => {
        const timeEntryId = readResourceId(args, "time_entry_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/time_entries/${encodeURIComponent(String(timeEntryId))}.json`
        })

        return responseFromRedmine(response, "Time entry deleted.")
    }
)

// User and group tools

defineTool(
    "list_users",
    "List users (admin permission may be required based on visibility settings).",
    {
        type: "object",
        properties: {
            status: { type: "integer", description: "1 active, 2 registered, 3 locked" },
            name: { type: "string", description: "Name filter" },
            group_id: { type: ["integer", "string"] },
            ...paginationProperties
        }
    },
    async (args) => {
        const response = await redmineRequest({
            method: "get",
            path: "/users.json",
            params: {
                status: args.status,
                name: args.name,
                group_id: args.group_id,
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })

        return responseFromRedmine(response, "Fetched users.")
    }
)

defineTool(
    "get_user",
    "Get one user by ID.",
    {
        type: "object",
        properties: {
            user_id: { type: ["integer", "string"] },
            include: { type: "string", description: "Optional includes, e.g. memberships,groups" }
        },
        required: ["user_id"]
    },
    async (args) => {
        const userId = readResourceId(args, "user_id")
        const response = await redmineRequest({
            method: "get",
            path: `/users/${encodeURIComponent(String(userId))}.json`,
            params: { include: args.include }
        })

        return responseFromRedmine(response, "Fetched user.")
    }
)

defineTool(
    "create_user",
    "Create user account (admin only).",
    {
        type: "object",
        properties: {
            login: { type: "string" },
            firstname: { type: "string" },
            lastname: { type: "string" },
            mail: { type: "string" },
            password: { type: "string" },
            auth_source_id: { type: ["integer", "string"] },
            generate_password: { type: "boolean" },
            must_change_passwd: { type: "boolean" },
            send_information: { type: "boolean" },
            admin: { type: "boolean" }
        },
        required: ["login", "firstname", "lastname", "mail"]
    },
    async (args) => {
        const user = compactObject({
            login: args.login,
            firstname: args.firstname,
            lastname: args.lastname,
            mail: args.mail,
            password: args.password,
            auth_source_id: args.auth_source_id,
            generate_password: args.generate_password,
            must_change_passwd: args.must_change_passwd,
            send_information: args.send_information,
            admin: args.admin
        })

        const response = await redmineRequest({
            method: "post",
            path: "/users.json",
            data: { user }
        })

        return responseFromRedmine(response, "User created.")
    }
)

defineTool(
    "update_user",
    "Update user account (admin only).",
    {
        type: "object",
        properties: {
            user_id: { type: ["integer", "string"] },
            login: { type: "string" },
            firstname: { type: "string" },
            lastname: { type: "string" },
            mail: { type: "string" },
            password: { type: "string" },
            auth_source_id: { type: ["integer", "string"] },
            generate_password: { type: "boolean" },
            must_change_passwd: { type: "boolean" },
            send_information: { type: "boolean" },
            admin: { type: "boolean" }
        },
        required: ["user_id"]
    },
    async (args) => {
        const userId = readResourceId(args, "user_id")
        const user = compactObject({
            login: args.login,
            firstname: args.firstname,
            lastname: args.lastname,
            mail: args.mail,
            password: args.password,
            auth_source_id: args.auth_source_id,
            generate_password: args.generate_password,
            must_change_passwd: args.must_change_passwd,
            send_information: args.send_information,
            admin: args.admin
        })

        const response = await redmineRequest({
            method: "put",
            path: `/users/${encodeURIComponent(String(userId))}.json`,
            data: { user }
        })

        return responseFromRedmine(response, "User updated.")
    }
)

defineTool(
    "delete_user",
    "Delete a user account by user_id (admin only).",
    {
        type: "object",
        properties: {
            user_id: { type: ["integer", "string"] }
        },
        required: ["user_id"]
    },
    async (args) => {
        const userId = readResourceId(args, "user_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/users/${encodeURIComponent(String(userId))}.json`
        })

        return responseFromRedmine(response, "User deleted.")
    }
)

defineTool(
    "list_groups",
    "List Redmine groups.",
    {
        type: "object",
        properties: {
            ...paginationProperties
        }
    },
    async (args) => {
        const response = await redmineRequest({
            method: "get",
            path: "/groups.json",
            params: {
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })

        return responseFromRedmine(response, "Fetched groups.")
    }
)

defineTool(
    "get_group",
    "Get one group by group_id.",
    {
        type: "object",
        properties: {
            group_id: { type: ["integer", "string"] },
            include: { type: "string", description: "Optional includes, e.g. users,memberships" }
        },
        required: ["group_id"]
    },
    async (args) => {
        const groupId = readResourceId(args, "group_id")
        const response = await redmineRequest({
            method: "get",
            path: `/groups/${encodeURIComponent(String(groupId))}.json`,
            params: { include: args.include }
        })

        return responseFromRedmine(response, "Fetched group.")
    }
)

// Membership and version tools

defineTool(
    "list_project_memberships",
    "List memberships for a project.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            ...paginationProperties
        },
        required: ["project_id"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/memberships.json`,
            params: {
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })

        return responseFromRedmine(response, "Fetched memberships.")
    }
)

defineTool(
    "create_project_membership",
    "Create a project membership.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            user_id: { type: ["integer", "string"] },
            role_ids: { type: "array", items: { type: ["integer", "string"] } }
        },
        required: ["project_id", "user_id", "role_ids"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const membership = {
            user_id: args.user_id,
            role_ids: normalizeArray(args.role_ids)
        }

        const response = await redmineRequest({
            method: "post",
            path: `/projects/${encodeURIComponent(String(projectId))}/memberships.json`,
            data: { membership }
        })

        return responseFromRedmine(response, "Membership created.")
    }
)

defineTool(
    "update_membership",
    "Update membership roles by membership_id.",
    {
        type: "object",
        properties: {
            membership_id: { type: ["integer", "string"] },
            role_ids: { type: "array", items: { type: ["integer", "string"] } }
        },
        required: ["membership_id", "role_ids"]
    },
    async (args) => {
        const membershipId = readResourceId(args, "membership_id")
        const response = await redmineRequest({
            method: "put",
            path: `/memberships/${encodeURIComponent(String(membershipId))}.json`,
            data: { membership: { role_ids: normalizeArray(args.role_ids) } }
        })

        return responseFromRedmine(response, "Membership updated.")
    }
)

defineTool(
    "delete_membership",
    "Delete membership by membership_id.",
    {
        type: "object",
        properties: {
            membership_id: { type: ["integer", "string"] }
        },
        required: ["membership_id"]
    },
    async (args) => {
        const membershipId = readResourceId(args, "membership_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/memberships/${encodeURIComponent(String(membershipId))}.json`
        })

        return responseFromRedmine(response, "Membership deleted.")
    }
)

defineTool(
    "list_project_versions",
    "List versions in a project.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            status: { type: "string", description: "open, locked, closed" },
            ...paginationProperties
        },
        required: ["project_id"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/versions.json`,
            params: {
                status: args.status,
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })

        return responseFromRedmine(response, "Fetched versions.")
    }
)

defineTool(
    "create_project_version",
    "Create a version in a project.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string" },
            sharing: { type: "string" },
            due_date: { type: "string", description: "YYYY-MM-DD" },
            wiki_page_title: { type: "string" }
        },
        required: ["project_id", "name"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const version = compactObject({
            name: args.name,
            description: args.description,
            status: args.status,
            sharing: args.sharing,
            due_date: args.due_date,
            wiki_page_title: args.wiki_page_title
        })

        const response = await redmineRequest({
            method: "post",
            path: `/projects/${encodeURIComponent(String(projectId))}/versions.json`,
            data: { version }
        })

        return responseFromRedmine(response, "Version created.")
    }
)

defineTool(
    "update_version",
    "Update a version by version_id.",
    {
        type: "object",
        properties: {
            version_id: { type: ["integer", "string"] },
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string" },
            sharing: { type: "string" },
            due_date: { type: "string" },
            wiki_page_title: { type: "string" }
        },
        required: ["version_id"]
    },
    async (args) => {
        const versionId = readResourceId(args, "version_id")
        const version = compactObject({
            name: args.name,
            description: args.description,
            status: args.status,
            sharing: args.sharing,
            due_date: args.due_date,
            wiki_page_title: args.wiki_page_title
        })

        const response = await redmineRequest({
            method: "put",
            path: `/versions/${encodeURIComponent(String(versionId))}.json`,
            data: { version }
        })

        return responseFromRedmine(response, "Version updated.")
    }
)

defineTool(
    "delete_version",
    "Delete a version by version_id.",
    {
        type: "object",
        properties: {
            version_id: { type: ["integer", "string"] }
        },
        required: ["version_id"]
    },
    async (args) => {
        const versionId = readResourceId(args, "version_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/versions/${encodeURIComponent(String(versionId))}.json`
        })

        return responseFromRedmine(response, "Version deleted.")
    }
)

// Project content tools

defineTool(
    "list_project_news",
    "List project news.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            ...paginationProperties
        },
        required: ["project_id"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/news.json`,
            params: {
                limit: args.limit || DEFAULT_LIMIT,
                offset: args.offset
            }
        })

        return responseFromRedmine(response, "Fetched project news.")
    }
)

defineTool(
    "list_project_files",
    "List project files.",
    {
        type: "object",
        properties: {
            project_id: idProperty
        },
        required: ["project_id"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/files.json`
        })

        return responseFromRedmine(response, "Fetched project files.")
    }
)

defineTool(
    "list_project_documents",
    "List project documents.",
    {
        type: "object",
        properties: {
            project_id: idProperty
        },
        required: ["project_id"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/documents.json`
        })

        return responseFromRedmine(response, "Fetched project documents.")
    }
)

// Wiki tools

defineTool(
    "list_wiki_pages",
    "List wiki pages in a project.",
    {
        type: "object",
        properties: {
            project_id: idProperty
        },
        required: ["project_id"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/wiki/index.json`
        })

        return responseFromRedmine(response, "Fetched wiki page index.")
    }
)

defineTool(
    "get_wiki_page",
    "Get one wiki page by title.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            title: { type: "string", description: "Wiki page title or path, e.g. Dev/Setup" },
            version: { type: ["integer", "string"] },
            include: { type: "string", description: "Optional includes, e.g. attachments" }
        },
        required: ["project_id", "title"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "get",
            path: `/projects/${encodeURIComponent(String(projectId))}/wiki/${encodeWikiTitle(args.title)}.json`,
            params: {
                version: args.version,
                include: args.include
            }
        })

        return responseFromRedmine(response, "Fetched wiki page.")
    }
)

defineTool(
    "update_wiki_page",
    "Create or update wiki page content.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            title: { type: "string" },
            text: { type: "string" },
            comments: { type: "string" },
            version: { type: ["integer", "string"] }
        },
        required: ["project_id", "title", "text"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const wikiPage = compactObject({
            text: args.text,
            comments: args.comments,
            version: args.version
        })

        const response = await redmineRequest({
            method: "put",
            path: `/projects/${encodeURIComponent(String(projectId))}/wiki/${encodeWikiTitle(args.title)}.json`,
            data: { wiki_page: wikiPage }
        })

        return responseFromRedmine(response, "Wiki page updated.")
    }
)

defineTool(
    "delete_wiki_page",
    "Delete a wiki page by title.",
    {
        type: "object",
        properties: {
            project_id: idProperty,
            title: { type: "string" }
        },
        required: ["project_id", "title"]
    },
    async (args) => {
        const projectId = readResourceId(args, "project_id")
        const response = await redmineRequest({
            method: "delete",
            path: `/projects/${encodeURIComponent(String(projectId))}/wiki/${encodeWikiTitle(args.title)}.json`
        })

        return responseFromRedmine(response, "Wiki page deleted.")
    }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema
        }))
    }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    const tool = tools.find((entry) => entry.name === name)

    if (!tool) {
        throw new Error(`Unknown tool: ${name}`)
    }

    try {
        return await tool.handler(args)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[redmineflux-mcp] ${name} failed: ${message}`)
        return responseJson({ ok: false, error: message, tool: name })
    }
})

async function start() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error(`[redmineflux-mcp] MCP server ready with ${tools.length} tools.`)
}

start().catch((error) => {
    console.error(`[redmineflux-mcp] Fatal startup error: ${error.message}`)
    process.exit(1)
})
