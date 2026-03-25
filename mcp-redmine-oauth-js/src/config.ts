import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  redmineUrl: required("REDMINE_URL").replace(/\/+$/, ""),
  redmineClientId: required("REDMINE_CLIENT_ID"),
  redmineClientSecret: required("REDMINE_CLIENT_SECRET"),
  host: process.env.MCP_HOST ?? "0.0.0.0",
  port: Number.parseInt(process.env.MCP_PORT ?? "8000", 10),
  baseUrl: (process.env.MCP_BASE_URL ?? `http://localhost:${process.env.MCP_PORT ?? "8000"}`).replace(/\/+$/, ""),
  redmineScopes: process.env.REDMINE_SCOPES?.trim() || "",
  jwtSecret: process.env.MCP_JWT_SECRET || crypto.randomBytes(32).toString("hex"),
  jwtTtlSeconds: Number.parseInt(process.env.MCP_JWT_TTL_SECONDS ?? "3600", 10)
};

