# frozen_string_literal: true

module RedminefluxMcp
  module NormalizeLoginPayload
    LOGIN_PATH = "/mcp/auth/login"
    LOOSE_JSON_PAIR_PATTERN = /(?:\A|,)\s*["']?([A-Za-z0-9_]+)["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/

    module_function

    def parse_loose_json_body(raw_body)
      normalized_body = raw_body.to_s.strip

      # Windows shells often send payload wrapped in single quotes.
      if normalized_body.start_with?("'") && normalized_body.end_with?("'")
        normalized_body = normalized_body[1..-2].to_s
      end

      if normalized_body.start_with?("{") && normalized_body.end_with?("}")
        normalized_body = normalized_body[1..-2].to_s
      end

      parameters = {}
      normalized_body.scan(LOOSE_JSON_PAIR_PATTERN) do |key, double_quoted, single_quoted, bare|
        parameters[key] = [double_quoted, single_quoted, bare&.strip].compact.first
      end
      parameters
    end
  end

  module RequestPatch
    def request_parameters
      super
    rescue ActionDispatch::Http::Parameters::ParseError => error
      raise error unless post?
      raise error unless path&.start_with?(NormalizeLoginPayload::LOGIN_PATH)

      content_type = get_header("CONTENT_TYPE").to_s
      raise error unless content_type.include?("application/json")

      normalized_parameters = NormalizeLoginPayload.parse_loose_json_body(raw_post)
      raise error if normalized_parameters.blank?

      normalized_parameters = ActionDispatch::Request::Utils.set_binary_encoding(
        self,
        normalized_parameters,
        path_parameters[:controller],
        path_parameters[:action]
      )
      ActionDispatch::Request::Utils.check_param_encoding(normalized_parameters)

      delete_header("action_dispatch.request.parameters")
      self.request_parameters = ActionDispatch::Request::Utils.normalize_encode_params(normalized_parameters)
    end

    def POST
      request_parameters
    end
  end
end
