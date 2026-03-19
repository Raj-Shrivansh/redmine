# frozen_string_literal: true

require 'test_helper'

class McpAuthControllerTest < Redmine::IntegrationTest
  fixtures :users, :email_addresses

  def test_login_accepts_valid_json
    post(
      "/mcp/auth/login",
      params: { username: "jsmith", password: "jsmith" }.to_json,
      headers: { "CONTENT_TYPE" => "application/json" }
    )

    assert_response :success

    body = JSON.parse(response.body)
    assert body["access_token"].present?
    assert_equal User.find_by_login("jsmith").api_key, body["redmine_api_key"]
  end

  def test_login_accepts_loose_json_style_payload
    post(
      "/mcp/auth/login",
      params: "{username:jsmith,password:jsmith}",
      headers: { "CONTENT_TYPE" => "application/json" }
    )

    assert_response :success

    body = JSON.parse(response.body)
    assert body["access_token"].present?
    assert_equal User.find_by_login("jsmith").api_key, body["redmine_api_key"]
  end

  def test_login_returns_bad_request_when_credentials_are_missing
    post(
      "/mcp/auth/login",
      params: "{}",
      headers: { "CONTENT_TYPE" => "application/json" }
    )

    assert_response :bad_request
    assert_equal "invalid_request", JSON.parse(response.body)["error"]
  end

  def test_me_authenticates_with_bearer_token
    token = RedminefluxMcp::TokenService.generate(User.find_by_login("jsmith"))

    get(
      "/mcp/auth/me",
      headers: { "Authorization" => "Bearer #{token}" }
    )

    assert_response :success

    body = JSON.parse(response.body)
    assert_equal "jsmith", body["login"]
  end
end
