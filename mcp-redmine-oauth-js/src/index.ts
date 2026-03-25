import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { RedmineClient } from "./redmine-client.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { getEffectiveScopes, setAllowedScopes } from "./scopes.js";
import { RedmineOAuthProxy } from "./auth.js";
import { runWithContext } from "./context.js";

if (config.redmineScopes) {
  setAllowedScopes(config.redmineScopes.split(/\s+/).filter(Boolean));
}

const mcpServer = new McpServer({
  name: "Redmine MCP Server with OAuth (JS)",
  version: "0.1.0"
});
const redmineClient = new RedmineClient(config.redmineUrl);
registerTools(mcpServer as unknown as Parameters<typeof registerTools>[0], redmineClient);
registerResources(mcpServer as unknown as Parameters<typeof registerResources>[0], redmineClient);
registerPrompts(mcpServer as unknown as Parameters<typeof registerPrompts>[0], redmineClient);

const oauthProxy = new RedmineOAuthProxy({
  redmineUrl: config.redmineUrl,
  redmineClientId: config.redmineClientId,
  redmineClientSecret: config.redmineClientSecret,
  baseUrl: config.baseUrl,
  jwtSecret: config.jwtSecret,
  jwtTtlSeconds: config.jwtTtlSeconds,
  getEffectiveScopes
});

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
oauthProxy.register(app);

const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", async (req, res) => {
  const context = await oauthProxy.authenticateFromHeader(req.header("authorization") ?? undefined);
  if (!context) {
    res.status(401).json({ error: "unauthorized", error_description: "Missing or invalid Bearer token." });
    return;
  }

  await runWithContext(context, async () => {
    const existingSessionId = req.header("mcp-session-id") ?? undefined;
    let transport = existingSessionId ? transports.get(existingSessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST") {
        res.status(400).json({ error: "invalid_request", error_description: "Start a session with POST." });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId: string) => {
          transports.set(sessionId, transport as StreamableHTTPServerTransport);
        }
      });

      (transport as StreamableHTTPServerTransport & { onclose?: () => void }).onclose = () => {
        const sid = (transport as StreamableHTTPServerTransport & { sessionId?: string }).sessionId;
        if (sid) transports.delete(sid);
      };

      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "mcp-redmine-oauth-js",
    mcp_endpoint: `${config.baseUrl}/mcp`,
    oauth_metadata: `${config.baseUrl}/.well-known/oauth-authorization-server`
  });
});

app.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`mcp-redmine-oauth-js listening on ${config.host}:${config.port}`);
});

