export const MAX_JOURNAL_ENTRIES = 25;

function asRecord(value: unknown): Record<string, unknown> {
  return (value as Record<string, unknown>) ?? {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

export function formatCreatedIssue(data: Record<string, unknown>): string {
  const issue = asRecord(data.issue);
  if (Object.keys(issue).length === 0) {
    return "Issue created but response was empty.";
  }
  const project = asRecord(issue.project);
  return `Issue #${issue.id ?? "?"} created successfully in project '${project.name ?? ""}': ${issue.subject ?? ""}`;
}

export function formatCreatedProject(data: Record<string, unknown>): string {
  const project = asRecord(data.project);
  if (Object.keys(project).length === 0) {
    return "Project created but response was empty.";
  }
  return `Project '${project.name ?? ""}' (identifier: ${project.identifier ?? ""}, id=${project.id ?? "?"}) created successfully.`;
}

export function formatWikiPage(data: Record<string, unknown>): string {
  const page = asRecord(data.wiki_page);
  if (Object.keys(page).length === 0) {
    return "Error: could not retrieve wiki page.";
  }

  const author = asRecord(page.author);
  const lines = [
    `# ${page.title ?? "Untitled"}`,
    "",
    `**Version:** ${page.version ?? "?"} | **Author:** ${author.name ?? "Unknown"} | **Updated:** ${page.updated_on ?? "N/A"}`,
    ""
  ];
  const text = String(page.text ?? "");
  lines.push(text ? text : "_(empty page)_");
  return lines.join("\n");
}

export function formatIssueList(data: Record<string, unknown>): string {
  const issues = asArray(data.issues);
  const totalCount = Number(data.total_count ?? 0);
  const offset = Number(data.offset ?? 0);
  const limit = Number(data.limit ?? 25);

  if (issues.length === 0) {
    return "No issues found matching the filters.";
  }

  const lines = [`Found ${totalCount} issue(s). Showing ${offset + 1}-${offset + issues.length}:`, ""];
  for (const issue of issues) {
    const status = asRecord(issue.status);
    const priority = asRecord(issue.priority);
    const assignee = asRecord(issue.assigned_to);

    lines.push(`- **#${issue.id ?? "?"}** ${issue.subject ?? "No subject"}`);
    const parts = [];
    if (status.name) parts.push(`Status: ${status.name}`);
    if (priority.name) parts.push(`Priority: ${priority.name}`);
    parts.push(`Assigned: ${assignee.name ?? "Unassigned"}`);
    const updated = String(issue.updated_on ?? "").slice(0, 10);
    if (updated) parts.push(`Updated: ${updated}`);
    lines.push(`  ${parts.join(" | ")}`);
  }

  if (offset + issues.length < totalCount) {
    lines.push("");
    lines.push(`_More results available. Use offset=${offset + limit} to see the next page._`);
  }
  return lines.join("\n");
}

export function formatRelations(issueId: number, data: Record<string, unknown>): string {
  const relations = asArray(data.relations);
  if (relations.length === 0) {
    return `Issue #${issueId} has no relations.`;
  }
  const lines = [`# Relations for Issue #${issueId}`, ""];
  for (const relation of relations) {
    const relationType = relation.relation_type ?? "related";
    const issueFrom = Number(relation.issue_id ?? 0);
    const issueTo = Number(relation.issue_to_id ?? 0);
    const delay = relation.delay;
    if (issueFrom === issueId) {
      lines.push(`- **${relationType}** -> #${issueTo}`);
    } else {
      lines.push(`- **${relationType}** <- #${issueFrom}`);
    }
    if (delay) {
      lines.push(`  Delay: ${delay} day(s)`);
    }
  }
  return lines.join("\n");
}

export function formatProject(data: Record<string, unknown>): string {
  const project = asRecord(data.project);
  if (Object.keys(project).length === 0) {
    return "Error: could not retrieve project details.";
  }

  const lines = [
    `# ${project.name ?? "Unnamed"}`,
    "",
    `**Identifier:** ${project.identifier ?? "N/A"}`,
    `**ID:** ${project.id ?? "N/A"}`,
    `**Status:** ${Number(project.status ?? 0) === 1 ? "active" : "closed/archived"}`,
    `**Created:** ${project.created_on ?? "N/A"}`,
    `**Updated:** ${project.updated_on ?? "N/A"}`
  ];

  if (project.homepage) {
    lines.push(`**Homepage:** ${project.homepage}`);
  }

  const description = String(project.description ?? "");
  if (description) {
    lines.push("", description);
  }

  const trackers = asArray(project.trackers);
  if (trackers.length > 0) {
    lines.push("", "## Trackers");
    for (const tracker of trackers) {
      lines.push(`- ${tracker.name ?? "Unnamed"} (id=${tracker.id ?? "?"})`);
    }
  }

  const categories = asArray(project.issue_categories);
  if (categories.length > 0) {
    lines.push("", "## Issue Categories");
    for (const category of categories) {
      lines.push(`- ${category.name ?? "Unnamed"} (id=${category.id ?? "?"})`);
    }
  }

  const modules = asArray(project.enabled_modules);
  if (modules.length > 0) {
    lines.push("", "## Enabled Modules");
    for (const mod of modules) {
      lines.push(`- ${mod.name ?? "unknown"}`);
    }
  }

  return lines.join("\n");
}

export function formatVersions(projectId: string, data: Record<string, unknown>): string {
  const versions = asArray(data.versions);
  if (versions.length === 0) {
    return `No versions found for project '${projectId}'.`;
  }
  const lines = [`# Versions for '${projectId}'`, ""];
  for (const version of versions) {
    const description = String(version.description ?? "");
    lines.push(`- **${version.name ?? "Unnamed"}** (id=${version.id ?? "?"}, status: ${version.status ?? "N/A"})`);
    lines.push(`  Due: ${version.due_date ?? "No due date"} | Sharing: ${version.sharing ?? "none"}`);
    if (description) {
      lines.push(`  ${description.length > 120 ? `${description.slice(0, 120)}...` : description}`);
    }
  }
  return lines.join("\n");
}

export function formatTimeEntries(data: Record<string, unknown>): string {
  const entries = asArray(data.time_entries);
  const totalCount = Number(data.total_count ?? 0);
  const offset = Number(data.offset ?? 0);
  const limit = Number(data.limit ?? 25);

  if (entries.length === 0) {
    return "No time entries found.";
  }

  const totalHours = entries.reduce((sum, entry) => sum + Number(entry.hours ?? 0), 0);
  const lines = [
    `Found ${totalCount} time entry/entries. Showing ${offset + 1}-${offset + entries.length} (${totalHours.toFixed(2)} hours on this page):`,
    ""
  ];
  for (const entry of entries) {
    const user = asRecord(entry.user);
    const project = asRecord(entry.project);
    const issue = asRecord(entry.issue);
    const activity = asRecord(entry.activity);
    const issueRef = issue.id ? ` (issue #${issue.id})` : "";
    lines.push(`- **${Number(entry.hours ?? 0).toFixed(2)}h** - ${user.name ?? "Unknown"} on ${entry.spent_on ?? ""}${issueRef}`);
    const parts: string[] = [];
    if (project.name) parts.push(`Project: ${project.name}`);
    if (activity.name) parts.push(`Activity: ${activity.name}`);
    if (parts.length > 0) lines.push(`  ${parts.join(" | ")}`);
    const comments = String(entry.comments ?? "");
    if (comments) {
      lines.push(`  "${comments.length > 120 ? `${comments.slice(0, 120)}...` : comments}"`);
    }
  }

  if (offset + entries.length < totalCount) {
    lines.push("", `_More results available. Use offset=${offset + limit} to see the next page._`);
  }
  return lines.join("\n");
}

export function formatSearchResults(data: Record<string, unknown>): string {
  const results = asArray(data.results);
  const totalCount = Number(data.total_count ?? 0);
  const offset = Number(data.offset ?? 0);
  const limit = Number(data.limit ?? 25);
  if (results.length === 0) {
    return "No issues found matching the query.";
  }

  const lines = [`Found ${totalCount} result(s). Showing ${offset + 1}-${offset + results.length}:`, ""];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const date = String(result.datetime ?? "").slice(0, 10);
    const description = String(result.description ?? "");
    lines.push(`${offset + i + 1}. **${result.title ?? "No title"}**`);
    if (date) lines.push(`   Date: ${date}`);
    if (result.url) lines.push(`   URL: ${result.url}`);
    if (description) {
      lines.push(`   ${description.length > 200 ? `${description.slice(0, 200)}...` : description}`);
    }
    lines.push("");
  }
  if (offset + results.length < totalCount) {
    lines.push(`_More results available. Use offset=${offset + limit} to see the next page._`);
  }
  return lines.join("\n");
}

export function formatIssue(issue: Record<string, unknown>): string {
  const project = asRecord(issue.project);
  const tracker = asRecord(issue.tracker);
  const status = asRecord(issue.status);
  const priority = asRecord(issue.priority);
  const author = asRecord(issue.author);
  const assignedTo = asRecord(issue.assigned_to);

  const lines = [
    `# Issue #${issue.id} - ${issue.subject ?? "No subject"}`,
    "",
    `**Project:** ${project.name ?? "N/A"}`,
    `**Tracker:** ${tracker.name ?? "N/A"}`,
    `**Status:** ${status.name ?? "N/A"}`,
    `**Priority:** ${priority.name ?? "N/A"}`,
    `**Author:** ${author.name ?? "N/A"}`,
    `**Assigned to:** ${assignedTo.name ?? "Unassigned"}`,
    `**Created:** ${issue.created_on ?? "N/A"}`,
    `**Updated:** ${issue.updated_on ?? "N/A"}`,
    ""
  ];

  const customFields = asArray(issue.custom_fields);
  if (customFields.length > 0) {
    lines.push("## Custom Fields");
    for (const field of customFields) {
      lines.push(`- **${field.name}:** ${field.value ?? ""}`);
    }
    lines.push("");
  }

  const description = String(issue.description ?? "");
  if (description) {
    lines.push("## Description", description, "");
  }

  const journals = asArray(issue.journals);
  if (journals.length > 0) {
    lines.push("## Journal / Comments");
    const truncated = journals.slice(0, MAX_JOURNAL_ENTRIES);
    for (const entry of truncated) {
      const user = asRecord(entry.user);
      const details = asArray(entry.details);
      const changes = details.map((detail) => `  - ${detail.name}: ${detail.old_value ?? ""} -> ${detail.new_value ?? ""}`);
      const notes = String(entry.notes ?? "");
      if (!notes && changes.length === 0) {
        continue;
      }
      lines.push(`### ${user.name ?? "Unknown"} - ${entry.created_on ?? ""}`);
      if (notes) lines.push(notes);
      if (changes.length > 0) lines.push(...changes);
      lines.push("");
    }
    if (journals.length > MAX_JOURNAL_ENTRIES) {
      lines.push(`_... and ${journals.length - MAX_JOURNAL_ENTRIES} more entries (truncated)._`);
    }
  }

  return lines.join("\n");
}

export function formatStatuses(data: Record<string, unknown>): string {
  const statuses = asArray(data.issue_statuses);
  if (statuses.length === 0) {
    return "No issue statuses found.";
  }
  const lines = [`# Issue Statuses (${statuses.length})`, ""];
  for (const status of statuses) {
    lines.push(`- **${status.name ?? "Unnamed"}** (id=${status.id ?? "?"})${status.is_closed ? " (closed)" : ""}`);
  }
  return lines.join("\n");
}

export function formatPriorities(data: Record<string, unknown>): string {
  const priorities = asArray(data.issue_priorities);
  if (priorities.length === 0) {
    return "No priority levels found.";
  }
  const lines = [`# Issue Priorities (${priorities.length})`, ""];
  for (const priority of priorities) {
    lines.push(`- **${priority.name ?? "Unnamed"}** (id=${priority.id ?? "?"})${priority.is_default ? " <- default" : ""}`);
  }
  return lines.join("\n");
}

export function formatProjects(data: Record<string, unknown>): string {
  const projects = asArray(data.projects);
  if (projects.length === 0) {
    return "No active projects found.";
  }
  const lines = [`# Active Projects (${projects.length})`, ""];
  for (const project of projects) {
    lines.push(`- **${project.name ?? "Unnamed"}** (\`${project.identifier ?? ""}\`, id=${project.id ?? "?"})`);
    const description = String(project.description ?? "");
    if (description) {
      lines.push(`  ${description.length > 120 ? `${description.slice(0, 120)}...` : description}`);
    }
  }
  return lines.join("\n");
}

export function formatTrackers(data: Record<string, unknown>): string {
  const trackers = asArray(data.trackers);
  if (trackers.length === 0) {
    return "No trackers found.";
  }
  const lines = [`# Trackers (${trackers.length})`, ""];
  for (const tracker of trackers) {
    const defaultStatus = asRecord(tracker.default_status);
    lines.push(`- **${tracker.name ?? "Unnamed"}** (id=${tracker.id ?? "?"}, default status: ${defaultStatus.name ?? "N/A"})`);
  }
  return lines.join("\n");
}

export function formatUser(data: Record<string, unknown>): string {
  const user = asRecord(data.user);
  if (Object.keys(user).length === 0) {
    return "Error: could not retrieve user profile.";
  }
  return [
    `# ${user.firstname ?? ""} ${user.lastname ?? ""}`.trim(),
    "",
    `**Login:** ${user.login ?? "N/A"}`,
    `**ID:** ${user.id ?? "N/A"}`,
    `**Email:** ${user.mail ?? "N/A"}`,
    `**Created:** ${user.created_on ?? "N/A"}`,
    `**Last login:** ${user.last_login_on ?? "N/A"}`,
    `**Admin:** ${String(user.admin ?? false)}`
  ].join("\n");
}

