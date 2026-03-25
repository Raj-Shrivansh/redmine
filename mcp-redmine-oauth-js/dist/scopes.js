import { getContext } from "./context.js";
export const VIEW_PROJECT = "view_project";
export const VIEW_ISSUES = "view_issues";
export const SEARCH_PROJECT = "search_project";
export const VIEW_TIME_ENTRIES = "view_time_entries";
export const ADD_ISSUES = "add_issues";
export const EDIT_ISSUES = "edit_issues";
export const ADD_PROJECT = "add_project";
export const EDIT_PROJECT = "edit_project";
export const VIEW_WIKI_PAGES = "view_wiki_pages";
export const EDIT_WIKI_PAGES = "edit_wiki_pages";
export const RENAME_WIKI_PAGES = "rename_wiki_pages";
const registry = new Set();
let allowedScopes = null;
export function declareScopes(...scopes) {
    for (const scope of scopes) {
        registry.add(scope);
    }
}
export function setAllowedScopes(scopes) {
    allowedScopes = new Set(scopes);
}
export function getRegisteredScopes() {
    return [...registry].sort();
}
export function getEffectiveScopes() {
    if (!allowedScopes) {
        return getRegisteredScopes();
    }
    return [...registry].filter((scope) => allowedScopes?.has(scope)).sort();
}
export function checkScope(grantedScopes, ...required) {
    const granted = new Set(grantedScopes ?? []);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
        return `Error: requires OAuth scope(s): ${missing.join(", ")}. Please re-authorize with the required permissions.`;
    }
    return null;
}
export function requireScopes(required, fn) {
    declareScopes(...required);
    return async (...args) => {
        const context = getContext();
        if (!context) {
            return "Error: not authenticated. Please complete the OAuth flow first.";
        }
        if (required.length > 0) {
            const error = checkScope(context.scopes, ...required);
            if (error) {
                return error;
            }
        }
        return fn(...args);
    };
}
