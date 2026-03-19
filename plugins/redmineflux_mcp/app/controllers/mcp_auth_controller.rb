# frozen_string_literal: true

class McpAuthController < ApplicationController
  layout false

  skip_before_action :verify_authenticity_token, only: %i[login me]
  skip_before_action :session_expiration, :user_setup, :check_if_login_required,
                     :set_localization, :check_password_change, :check_twofa_activation,
                     only: %i[login me]

  def login
    credentials = login_credentials
    username = credentials[:username].to_s
    password = credentials[:password].to_s

    unless username.present? && password.present?
      render json: { error: "invalid_request", message: "username and password are required" }, status: :bad_request
      return
    end

    user = User.find_by_login(username)

    if user&.check_password?(password)
      token = RedminefluxMcp::TokenService.generate(user)

      render json: {
        access_token: token,
        redmine_api_key: user.api_key,
        login: user.login,
        user_id: user.id
      }
    else
      render json: { error: "invalid_credentials", message: "Username or password is invalid" }, status: :unauthorized
    end
  end

  def me
    user = RedminefluxMcp::TokenService.authenticate(request)

    if user
      render json: {
        id: user.id,
        login: user.login,
        api_key: user.api_key
      }
    else
      render json: { error: "unauthorized" }, status: :unauthorized
    end
  end

  private

  def api_request?
    true
  end

  def params
    super
  rescue ActionDispatch::Http::Parameters::ParseError
    @_safe_params ||= ActionController::Parameters.new(
      request.path_parameters.merge(request.query_parameters).merge(parsed_request_body)
    )
  end

  def login_credentials
    request.query_parameters.merge(parsed_request_body).with_indifferent_access.slice(:username, :password)
  end

  def parsed_request_body
    body_parameters = request.request_parameters
    body_parameters.is_a?(Hash) ? body_parameters : {}
  rescue ActionDispatch::Http::Parameters::ParseError
    parse_raw_request_body(request.raw_post)
  end

  def parse_raw_request_body(raw_body)
    body = raw_body.to_s.strip
    return {} if body.blank?

    parsed_json = JSON.parse(body)
    return parsed_json if parsed_json.is_a?(Hash)

    {}
  rescue JSON::ParserError
    parse_form_encoded_body(body).presence || parse_loose_json_body(body)
  end

  def parse_form_encoded_body(body)
    return {} unless body.include?("=")

    Rack::Utils.parse_nested_query(body)
  rescue ArgumentError
    {}
  end

  def parse_loose_json_body(body)
    RedminefluxMcp::NormalizeLoginPayload.parse_loose_json_body(body)
  end
end
