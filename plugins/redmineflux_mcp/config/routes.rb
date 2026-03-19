# frozen_string_literal: true

post "/mcp/auth/login", to: "mcp_auth#login"
get "/mcp/auth/me", to: "mcp_auth#me"

get "/mcp/settings", to: "mcp_settings#index", as: :redmineflux_mcp_settings
