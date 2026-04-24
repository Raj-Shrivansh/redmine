# frozen_string_literal: true

require_relative '../test_helper'

# QA-only dummy tests for validating:
# - rfd-087 failed-test -> create-issue flow
# - rfd-088 test-to-requirement traceability parsing
#
# These tests intentionally fail so CI produces failed testcase rows that can
# be ingested by Redmineflux DevOps and linked to real issue IDs.
class Rfd087088TraceabilityDummyTest < ActiveSupport::TestCase
  ISSUE_IDS = [102, 110, 237, 238, 239, 240, 241, 242, 243, 244, 245, 256, 257].freeze

  ISSUE_IDS.each_with_index do |issue_id, idx|
    # Rotate tag formats so parser coverage includes all supported patterns.
    trace_tag =
      case idx % 3
      when 0
        "##{issue_id}"
      when 1
        "[issue-#{issue_id}]"
      else
        "@issue#{issue_id}"
      end

    test "qa dummy failed testcase #{trace_tag} [TCM-#{issue_id}]" do
      flunk("Intentional QA failure for rfd-087/rfd-088 issue #{issue_id}")
    end
  end
end
