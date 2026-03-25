import { z } from "zod";
import { getContext } from "./context.js";
import {
  formatCreatedIssue,
  formatCreatedProject,
  formatIssue,
  formatIssueList,
  formatProject,
  formatRelations,
  formatSearchResults,
  formatTimeEntries,
  formatVersions,
  formatWikiPage
} from "./formatters.js";
import {
  ADD_ISSUES,
  ADD_PROJECT,
  EDIT_ISSUES,
  EDIT_PROJECT,
  EDIT_WIKI_PAGES,
  RENAME_WIKI_PAGES,
  SEARCH_PROJECT,
  VIEW_ISSUES,
  VIEW_PROJECT,
  VIEW_TIME_ENTRIES,
  VIEW_WIKI_PAGES,
  requireScopes
} from "./scopes.js";
import {
  RedmineClient,
  RedmineForbiddenError,
  RedmineNotFoundError,
  RedmineValidationError
} from "./redmine-client.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function getToken(): string {
  const ctx = getContext();
  if (!ctx) {
    throw new Error("Missing auth context");
  }
  return ctx.redmineAccessToken;
}

type AnyServer = {
  tool: (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>
  ) => void;
};

export function registerTools(server: AnyServer, redmine: RedmineClient): void {
  server.tool(
    "get_issue_details",
    "Fetch full Redmine issue details including description, custom fields, and journals.",
    { issue_id: z.number().int() },
    async (args) => {
      const run = requireScopes([VIEW_ISSUES], async (issueId: number) => {
        try {
          const data = await redmine.get(`/issues/${issueId}.json`, getToken(), { include: "journals" });
          return formatIssue((data.issue as Record<string, unknown>) ?? {});
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to view issue #${issueId}.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: issue #${issueId} not found in Redmine.`;
          }
          throw error;
        }
      });
      return textResult(await run(Number(args.issue_id)));
    }
  );

  server.tool(
    "search_issues",
    "Search Redmine issues by full-text query.",
    {
      query: z.string().min(1),
      project_id: z.string().optional(),
      open_issues_only: z.boolean().default(true),
      offset: z.number().int().default(0),
      limit: z.number().int().default(25)
    },
    async (args) => {
      const run = requireScopes([VIEW_ISSUES, SEARCH_PROJECT], async (input: Record<string, unknown>) => {
        const params: Record<string, string | number> = {
          q: String(input.query),
          issues: 1,
          offset: Number(input.offset ?? 0),
          limit: Number(input.limit ?? 25)
        };
        if (input.open_issues_only !== false) params.open_issues = 1;

        const projectId = input.project_id ? String(input.project_id) : null;
        const path = projectId ? `/projects/${projectId}/search.json` : "/search.json";

        try {
          const data = await redmine.get(path, getToken(), params);
          return formatSearchResults(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return "Error: you do not have permission to search in this project.";
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: project '${projectId}' not found in Redmine.`;
          }
          throw error;
        }
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "list_issues",
    "List Redmine issues with optional filters.",
    {
      project_id: z.string().optional(),
      assigned_to_id: z.string().optional(),
      status_id: z.string().optional(),
      tracker_id: z.number().int().optional(),
      sort: z.string().optional(),
      offset: z.number().int().default(0),
      limit: z.number().int().default(25)
    },
    async (args) => {
      const run = requireScopes([VIEW_ISSUES], async (input: Record<string, unknown>) => {
        const params: Record<string, string | number> = {
          offset: Number(input.offset ?? 0),
          limit: Number(input.limit ?? 25)
        };
        if (input.project_id) params.project_id = String(input.project_id);
        if (input.assigned_to_id) params.assigned_to_id = String(input.assigned_to_id);
        if (input.status_id) params.status_id = String(input.status_id);
        if (typeof input.tracker_id === "number") params.tracker_id = input.tracker_id;
        if (input.sort) params.sort = String(input.sort);
        try {
          const data = await redmine.get("/issues.json", getToken(), params);
          return formatIssueList(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return "Error: you do not have permission to list issues.";
          }
          throw error;
        }
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "get_issue_relations",
    "Get issue relations (blocking, blocked-by, related).",
    { issue_id: z.number().int() },
    async (args) => {
      const run = requireScopes([VIEW_ISSUES], async (issueId: number) => {
        try {
          const data = await redmine.get(`/issues/${issueId}/relations.json`, getToken());
          return formatRelations(issueId, data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to view issue #${issueId} relations.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: issue #${issueId} not found in Redmine.`;
          }
          throw error;
        }
      });
      return textResult(await run(Number(args.issue_id)));
    }
  );

  server.tool(
    "get_project_details",
    "Get detailed information about a Redmine project.",
    { project_id: z.string() },
    async (args) => {
      const run = requireScopes([VIEW_PROJECT], async (projectId: string) => {
        try {
          const data = await redmine.get(`/projects/${projectId}.json`, getToken(), {
            include: "trackers,issue_categories,enabled_modules"
          });
          return formatProject(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to view project '${projectId}'.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: project '${projectId}' not found in Redmine.`;
          }
          throw error;
        }
      });
      return textResult(await run(String(args.project_id)));
    }
  );

  server.tool(
    "get_project_versions",
    "Get versions/milestones for a Redmine project.",
    { project_id: z.string() },
    async (args) => {
      const run = requireScopes([VIEW_PROJECT], async (projectId: string) => {
        try {
          const data = await redmine.get(`/projects/${projectId}/versions.json`, getToken());
          return formatVersions(projectId, data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to view project '${projectId}' versions.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: project '${projectId}' not found in Redmine.`;
          }
          throw error;
        }
      });
      return textResult(await run(String(args.project_id)));
    }
  );

  server.tool(
    "list_time_entries",
    "List Redmine time entries with optional filters.",
    {
      project_id: z.string().optional(),
      user_id: z.string().optional(),
      from_date: z.string().optional(),
      to_date: z.string().optional(),
      offset: z.number().int().default(0),
      limit: z.number().int().default(25)
    },
    async (args) => {
      const run = requireScopes([VIEW_TIME_ENTRIES], async (input: Record<string, unknown>) => {
        const params: Record<string, string | number> = {
          offset: Number(input.offset ?? 0),
          limit: Number(input.limit ?? 25)
        };
        if (input.project_id) params.project_id = String(input.project_id);
        if (input.user_id) params.user_id = String(input.user_id);
        if (input.from_date) params.from = String(input.from_date);
        if (input.to_date) params.to = String(input.to_date);
        try {
          const data = await redmine.get("/time_entries.json", getToken(), params);
          return formatTimeEntries(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return "Error: you do not have permission to view time entries.";
          }
          throw error;
        }
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "create_issue",
    "Create a new Redmine issue.",
    {
      project_id: z.string(),
      subject: z.string(),
      tracker_id: z.number().int().optional(),
      description: z.string().optional(),
      priority_id: z.number().int().optional(),
      assigned_to_id: z.number().int().optional(),
      status_id: z.number().int().optional(),
      category_id: z.number().int().optional(),
      fixed_version_id: z.number().int().optional(),
      parent_issue_id: z.number().int().optional()
    },
    async (args) => {
      const run = requireScopes([ADD_ISSUES], async (input: Record<string, unknown>) => {
        const issueData: Record<string, unknown> = {
          project_id: String(input.project_id),
          subject: String(input.subject)
        };
        const optional = [
          "tracker_id",
          "description",
          "priority_id",
          "assigned_to_id",
          "status_id",
          "category_id",
          "fixed_version_id",
          "parent_issue_id"
        ];
        for (const field of optional) {
          if (input[field] !== undefined) issueData[field] = input[field];
        }
        try {
          const data = await redmine.post("/issues.json", getToken(), { issue: issueData });
          return formatCreatedIssue(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return "Error: you do not have permission to create issues in this project.";
          }
          if (error instanceof RedmineValidationError) {
            return `Error: validation failed - ${error.errors.length > 0 ? error.errors.join("; ") : "unknown error"}.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: project '${input.project_id}' not found in Redmine.`;
          }
          throw error;
        }
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "update_issue",
    "Update an existing Redmine issue.",
    {
      issue_id: z.number().int(),
      notes: z.string().optional(),
      status_id: z.number().int().optional(),
      assigned_to_id: z.number().int().optional(),
      priority_id: z.number().int().optional(),
      subject: z.string().optional(),
      description: z.string().optional(),
      tracker_id: z.number().int().optional(),
      category_id: z.number().int().optional(),
      fixed_version_id: z.number().int().optional()
    },
    async (args) => {
      const run = requireScopes([EDIT_ISSUES], async (input: Record<string, unknown>) => {
        const issueData: Record<string, unknown> = {};
        for (const key of [
          "notes",
          "status_id",
          "assigned_to_id",
          "priority_id",
          "subject",
          "description",
          "tracker_id",
          "category_id",
          "fixed_version_id"
        ]) {
          if (input[key] !== undefined) issueData[key] = input[key];
        }
        if (Object.keys(issueData).length === 0) {
          return "Error: no fields to update. Provide at least one field to change.";
        }
        const issueId = Number(input.issue_id);
        try {
          await redmine.put(`/issues/${issueId}.json`, getToken(), { issue: issueData });
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to update issue #${issueId}.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: issue #${issueId} not found in Redmine.`;
          }
          if (error instanceof RedmineValidationError) {
            return `Error: validation failed - ${error.errors.length > 0 ? error.errors.join("; ") : "unknown error"}.`;
          }
          throw error;
        }
        return `Issue #${issueId} updated successfully. Changed: ${Object.keys(issueData).join(", ")}.`;
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "create_project",
    "Create a new Redmine project.",
    {
      name: z.string(),
      identifier: z.string(),
      description: z.string().optional(),
      is_public: z.boolean().optional(),
      parent_id: z.number().int().optional(),
      tracker_ids: z.array(z.number().int()).optional()
    },
    async (args) => {
      const run = requireScopes([ADD_PROJECT], async (input: Record<string, unknown>) => {
        const projectData: Record<string, unknown> = {
          name: String(input.name),
          identifier: String(input.identifier)
        };
        for (const key of ["description", "is_public", "parent_id", "tracker_ids"]) {
          if (input[key] !== undefined) projectData[key] = input[key];
        }
        try {
          const data = await redmine.post("/projects.json", getToken(), { project: projectData });
          return formatCreatedProject(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return "Error: you do not have permission to create projects.";
          }
          if (error instanceof RedmineValidationError) {
            return `Error: validation failed - ${error.errors.length > 0 ? error.errors.join("; ") : "unknown error"}.`;
          }
          throw error;
        }
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "update_project",
    "Update an existing Redmine project.",
    {
      project_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      is_public: z.boolean().optional(),
      parent_id: z.number().int().optional(),
      tracker_ids: z.array(z.number().int()).optional()
    },
    async (args) => {
      const run = requireScopes([EDIT_PROJECT], async (input: Record<string, unknown>) => {
        const projectId = String(input.project_id);
        const projectData: Record<string, unknown> = {};
        for (const key of ["name", "description", "is_public", "parent_id", "tracker_ids"]) {
          if (input[key] !== undefined) projectData[key] = input[key];
        }
        if (Object.keys(projectData).length === 0) {
          return "Error: no fields to update. Provide at least one field to change.";
        }
        try {
          await redmine.put(`/projects/${projectId}.json`, getToken(), { project: projectData });
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to update project '${projectId}'.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: project '${projectId}' not found in Redmine.`;
          }
          if (error instanceof RedmineValidationError) {
            return `Error: validation failed - ${error.errors.length > 0 ? error.errors.join("; ") : "unknown error"}.`;
          }
          throw error;
        }
        return `Project '${projectId}' updated successfully. Changed: ${Object.keys(projectData).join(", ")}.`;
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "get_wiki_page",
    "Get a wiki page from a Redmine project.",
    {
      project_id: z.string(),
      page_title: z.string().default("Wiki")
    },
    async (args) => {
      const run = requireScopes([VIEW_WIKI_PAGES], async (input: Record<string, unknown>) => {
        const projectId = String(input.project_id);
        const pageTitle = String(input.page_title ?? "Wiki");
        try {
          const data = await redmine.get(`/projects/${projectId}/wiki/${pageTitle}.json`, getToken());
          return formatWikiPage(data);
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to view wiki pages in project '${projectId}'.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: wiki page '${pageTitle}' not found in project '${projectId}'.`;
          }
          throw error;
        }
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "update_wiki_page",
    "Create or update a wiki page.",
    {
      project_id: z.string(),
      page_title: z.string(),
      content: z.string(),
      comments: z.string().optional()
    },
    async (args) => {
      const run = requireScopes([EDIT_WIKI_PAGES], async (input: Record<string, unknown>) => {
        const projectId = String(input.project_id);
        const pageTitle = String(input.page_title);
        const wikiPage: Record<string, unknown> = { text: String(input.content) };
        if (input.comments) wikiPage.comments = String(input.comments);
        try {
          await redmine.put(`/projects/${projectId}/wiki/${pageTitle}.json`, getToken(), { wiki_page: wikiPage });
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to edit wiki pages in project '${projectId}'.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: project '${projectId}' not found in Redmine.`;
          }
          if (error instanceof RedmineValidationError) {
            return `Error: validation failed - ${error.errors.length > 0 ? error.errors.join("; ") : "unknown error"}.`;
          }
          throw error;
        }
        return `Wiki page '${pageTitle}' in project '${projectId}' saved successfully.`;
      });
      return textResult(await run(args));
    }
  );

  server.tool(
    "rename_wiki_page",
    "Rename a wiki page in Redmine.",
    {
      project_id: z.string(),
      page_title: z.string(),
      new_title: z.string(),
      create_redirect: z.boolean().default(true)
    },
    async (args) => {
      const run = requireScopes([RENAME_WIKI_PAGES], async (input: Record<string, unknown>) => {
        const projectId = String(input.project_id);
        const pageTitle = String(input.page_title);
        const newTitle = String(input.new_title);
        const createRedirect = input.create_redirect !== false;
        const wikiPage: Record<string, unknown> = { title: newTitle };
        if (!createRedirect) wikiPage.redirect_existing_links = 0;
        try {
          await redmine.put(`/projects/${projectId}/wiki/${pageTitle}.json`, getToken(), { wiki_page: wikiPage });
        } catch (error) {
          if (error instanceof RedmineForbiddenError) {
            return `Error: you do not have permission to rename wiki pages in project '${projectId}'.`;
          }
          if (error instanceof RedmineNotFoundError) {
            return `Error: wiki page '${pageTitle}' not found in project '${projectId}'.`;
          }
          if (error instanceof RedmineValidationError) {
            return `Error: validation failed - ${error.errors.length > 0 ? error.errors.join("; ") : "unknown error"}.`;
          }
          throw error;
        }
        const redirectNote = createRedirect ? " A redirect from the old title was created." : "";
        return `Wiki page renamed from '${pageTitle}' to '${newTitle}' in project '${projectId}'.${redirectNote}`;
      });
      return textResult(await run(args));
    }
  );
}
