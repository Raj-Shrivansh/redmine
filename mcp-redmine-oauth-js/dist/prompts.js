import { z } from "zod";
import { getContext } from "./context.js";
import { RedmineForbiddenError, RedmineNotFoundError } from "./redmine-client.js";
import { VIEW_ISSUES, VIEW_PROJECT, requireScopes } from "./scopes.js";
function token() {
    const context = getContext();
    if (!context)
        throw new Error("Missing auth context");
    return context.redmineAccessToken;
}
function promptResult(text) {
    return { messages: [{ role: "user", content: { type: "text", text } }] };
}
export function registerPrompts(server, redmine) {
    server.prompt("summarize_ticket", "Generate a concise summary of a Redmine issue.", { issue_id: z.number().int() }, async (args) => {
        const run = requireScopes([VIEW_ISSUES], async (issueId) => {
            try {
                const data = await redmine.get(`/issues/${issueId}.json`, token(), { include: "journals" });
                const issue = data.issue ?? {};
                const journals = Array.isArray(issue.journals) ? issue.journals : [];
                const notes = journals
                    .slice(-15)
                    .map((entry) => {
                    const text = String(entry.notes ?? "");
                    if (!text)
                        return null;
                    const user = (entry.user ?? {}).name ?? "Unknown";
                    return `- ${user}: ${text}`;
                })
                    .filter((x) => Boolean(x));
                return `Please summarize the following Redmine issue concisely.

**Issue #${issueId}: ${issue.subject ?? "No subject"}**
- Status: ${(issue.status ?? {}).name ?? "N/A"}
- Priority: ${(issue.priority ?? {}).name ?? "N/A"}
- Assigned to: ${(issue.assigned_to ?? {}).name ?? "Unassigned"}

**Description:**
${String(issue.description ?? "") || "(no description)"}

**Recent discussion (${notes.length} comments):**
${notes.length > 0 ? notes.join("\n") : "(no comments)"}

Provide:
1. A one-paragraph summary of what this issue is about
2. Current status and blockers (if any)
3. Suggested next steps`;
            }
            catch (error) {
                if (error instanceof RedmineForbiddenError) {
                    return `Error: you do not have permission to view issue #${issueId}.`;
                }
                if (error instanceof RedmineNotFoundError) {
                    return `Error: issue #${issueId} not found in Redmine.`;
                }
                throw error;
            }
        });
        return promptResult(await run(Number(args.issue_id)));
    });
    server.prompt("draft_bug_report", "Draft a structured bug report from rough notes.", {
        project_id: z.string(),
        rough_notes: z.string()
    }, async (args) => {
        const run = requireScopes([VIEW_PROJECT], async (input) => {
            const projectId = String(input.project_id);
            try {
                const data = await redmine.get(`/projects/${projectId}.json`, token(), {
                    include: "trackers,issue_categories"
                });
                const project = data.project ?? {};
                const trackers = Array.isArray(project.trackers) ? project.trackers : [];
                const categories = Array.isArray(project.issue_categories)
                    ? project.issue_categories
                    : [];
                const trackerList = trackers.map((t) => `${t.name} (id=${t.id})`).join(", ") || "N/A";
                const categoryList = categories.map((c) => `${c.name} (id=${c.id})`).join(", ") || "N/A";
                const projectName = String(project.name ?? projectId);
                const roughNotes = String(input.rough_notes);
                return `Please draft a structured bug report for project "${projectName}" based on the rough notes below.

**Available trackers:** ${trackerList}
**Available categories:** ${categoryList}

**Rough notes:**
${roughNotes}

Please produce:
1. **Subject** - a clear, concise one-line title
2. **Tracker** - suggest which tracker to use (with ID)
3. **Priority** - suggest a priority level (Low/Normal/High/Urgent/Immediate)
4. **Description** - a well-structured bug report with:
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Environment details (if inferable from notes)
5. **Category** - suggest a category if applicable (with ID)

Format the output so it can be directly used with the \`create_issue\` tool.`;
            }
            catch (error) {
                if (error instanceof RedmineForbiddenError) {
                    return `Error: you do not have permission to view project '${projectId}'.`;
                }
                if (error instanceof RedmineNotFoundError) {
                    return `Error: project '${projectId}' not found in Redmine.`;
                }
                throw error;
            }
        });
        return promptResult(await run(args));
    });
}
