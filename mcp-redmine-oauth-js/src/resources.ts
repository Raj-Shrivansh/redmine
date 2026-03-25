import { getContext } from "./context.js";
import { formatPriorities, formatProjects, formatStatuses, formatTrackers, formatUser } from "./formatters.js";
import { RedmineClient } from "./redmine-client.js";
import { VIEW_ISSUES, VIEW_PROJECT, declareScopes, requireScopes } from "./scopes.js";

type AnyServer = {
  resource: (
    name: string,
    uri: string,
    handler: () => Promise<{ contents: Array<{ uri: string; text: string; mimeType?: string }> }>
  ) => void;
};

function token(): string {
  const context = getContext();
  if (!context) throw new Error("Missing auth context");
  return context.redmineAccessToken;
}

function resourceResult(uri: string, text: string) {
  return { contents: [{ uri, text, mimeType: "text/plain" }] };
}

export function registerResources(server: AnyServer, redmine: RedmineClient): void {
  server.resource("projects_active", "redmine://projects/active", async () => {
    const run = requireScopes([VIEW_PROJECT], async () => {
      const data = await redmine.get("/projects.json", token(), { status: 1 });
      return formatProjects(data);
    });
    return resourceResult("redmine://projects/active", await run());
  });

  server.resource("trackers", "redmine://trackers", async () => {
    const run = requireScopes([VIEW_PROJECT], async () => {
      const data = await redmine.get("/trackers.json", token());
      return formatTrackers(data);
    });
    return resourceResult("redmine://trackers", await run());
  });

  declareScopes();
  server.resource("users_me", "redmine://users/me", async () => {
    const run = requireScopes([], async () => {
      const data = await redmine.get("/users/current.json", token());
      return formatUser(data);
    });
    return resourceResult("redmine://users/me", await run());
  });

  server.resource("issue_statuses", "redmine://issue-statuses", async () => {
    const run = requireScopes([VIEW_ISSUES], async () => {
      const data = await redmine.get("/issue_statuses.json", token());
      return formatStatuses(data);
    });
    return resourceResult("redmine://issue-statuses", await run());
  });

  server.resource("issue_priorities", "redmine://enumerations/priorities", async () => {
    const run = requireScopes([VIEW_ISSUES], async () => {
      const data = await redmine.get("/enumerations/issue_priorities.json", token());
      return formatPriorities(data);
    });
    return resourceResult("redmine://enumerations/priorities", await run());
  });
}

