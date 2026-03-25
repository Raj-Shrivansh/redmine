# mcp-redmine-oauth-js

JavaScript/TypeScript port of the Python `mcp-redmine-oauth` server.

This server:
- exposes Redmine tools, resources, and prompts over MCP Streamable HTTP
- uses Redmine OAuth 2.0 for user authorization
- issues local Bearer JWTs to MCP clients while keeping Redmine tokens server-side

## Implemented MCP Surface

Tools:
- `get_issue_details`
- `search_issues`
- `list_issues`
- `get_issue_relations`
- `get_project_details`
- `get_project_versions`
- `list_time_entries`
- `create_issue`
- `update_issue`
- `create_project`
- `update_project`
- `get_wiki_page`
- `update_wiki_page`
- `rename_wiki_page`

Resources:
- `redmine://projects/active`
- `redmine://trackers`
- `redmine://users/me`
- `redmine://issue-statuses`
- `redmine://enumerations/priorities`

Prompts:
- `summarize_ticket`
- `draft_bug_report`

## Setup

```bash
cd mcp-redmine-oauth-js
cp .env.example .env
npm install
```

Fill `.env`:

```env
REDMINE_URL=http://your-redmine-host
REDMINE_CLIENT_ID=...
REDMINE_CLIENT_SECRET=...
```

## Run

```bash
npm run dev
```

Build + run:

```bash
npm run build
npm start
```

## Endpoints

- MCP endpoint: `http://localhost:8000/mcp`
- OAuth metadata: `http://localhost:8000/.well-known/oauth-authorization-server`
- OAuth authorize: `http://localhost:8000/auth/authorize`
- OAuth callback: `http://localhost:8000/auth/callback`
- OAuth token: `http://localhost:8000/auth/token`

## Notes

- Token/session storage is in-memory.
- Redmine access token refresh is supported when Redmine returns refresh tokens.
- Set `MCP_JWT_SECRET` in production to avoid invalidating issued JWTs on restart.

