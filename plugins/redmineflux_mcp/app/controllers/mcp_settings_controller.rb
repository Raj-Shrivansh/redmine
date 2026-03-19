# frozen_string_literal: true

class McpSettingsController < ApplicationController
  layout "admin"
  before_action :require_admin

  def index
    @plugin_directory = Redmine::Plugin.find(:redmineflux_mcp).directory.to_s
    @run_script_path = File.join(@plugin_directory, "mcp-server", "run-server.sh")
    @redmine_url = configured_redmine_url
    @claude_config_json = JSON.pretty_generate(claude_config_template)
    @claude_config_with_api_key_json = JSON.pretty_generate(claude_config_template(include_api_key: true))
  end

  private

  def configured_redmine_url
    configured = Setting.plugin_redmineflux_mcp["server_url"].to_s.strip
    return configured if configured.present?

    protocol = Setting.protocol.presence || "http"
    host_name = Setting.host_name.presence || "127.0.0.1:3000"

    "#{protocol}://#{host_name}"
  end

  def claude_config_template(include_api_key: false)
    env = {
      "REDMINE_URL" => @redmine_url
    }
    env["REDMINE_API_KEY"] = "paste_redmine_api_key_here" if include_api_key

    {
      "mcpServers" => {
        "redmineflux" => {
          "command" => @run_script_path,
          "env" => env
        }
      }
    }
  end
end
