# frozen_string_literal: true

require "jwt"

module RedminefluxMcp
  class TokenService
    ALGORITHM = "HS256"

    class << self
      def generate(user)
        payload = {
          user_id: user.id,
          iat: Time.current.to_i,
          exp: 24.hours.from_now.to_i
        }

        JWT.encode(payload, secret, ALGORITHM)
      end

      def authenticate(request)
        token = bearer_token_from(request)
        return nil if token.blank?

        payload = JWT.decode(token, secret, true, { algorithm: ALGORITHM }).first
        User.find_by(id: payload["user_id"])
      rescue JWT::DecodeError, JWT::ExpiredSignature, JWT::VerificationError, JWT::IncorrectAlgorithm
        nil
      end

      private

      def bearer_token_from(request)
        header = request.headers["Authorization"].to_s
        return nil unless header.start_with?("Bearer ")

        header.split(" ", 2).last
      end

      def secret
        env_secret = ENV["REDMINEFLUX_MCP_JWT_SECRET"].to_s
        return env_secret if env_secret.present?

        plugin_secret = Setting.plugin_redmineflux_mcp["jwt_secret"].to_s
        return plugin_secret if plugin_secret.present?

        Rails.application.secret_key_base.to_s
      rescue StandardError
        Rails.application.secret_key_base.to_s
      end
    end
  end
end

RedmineAiMcp = RedminefluxMcp unless defined?(RedmineAiMcp)
