# frozen_string_literal: true

require File.expand_path("./lib/redmineflux_mcp/token_service", __dir__)
require File.expand_path("./lib/redmineflux_mcp/normalize_login_payload", __dir__)

Redmine::Plugin.register :redmineflux_mcp do
  name "Redmineflux MCP plugin"
  author "Redmineflux - Powered by Zehntech Technologies Inc"
  description "Plug-and-play MCP server bridge for Redmine"
  version "1.1.0"
  url "https://www.redmineflux.com"
  author_url "https://www.redmineflux.com"
  requires_redmine version_or_higher: "5.0"

  menu :admin_menu, :redmineflux_mcp_settings,
       { controller: "mcp_settings", action: "index" },
       caption: :label_redmineflux_mcp,
       if: proc { User.current.admin? }

  settings default: {
    "server_url" => "",
    "jwt_secret" => ""
  }, partial: "settings/redmineflux_mcp_settings"
end

unless ActionDispatch::Request.ancestors.include?(RedminefluxMcp::RequestPatch)
  ActionDispatch::Request.prepend(RedminefluxMcp::RequestPatch)
end
