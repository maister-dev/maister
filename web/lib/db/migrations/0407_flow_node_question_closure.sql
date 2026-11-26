ALTER TABLE "hitl_requests" DROP CONSTRAINT "hitl_requests_agent_question_supersession_check";--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_agent_question_supersession_check" CHECK ((
        "hitl_requests"."kind" <> 'agent_question'
        AND "hitl_requests"."superseded_at" IS NULL
        AND "hitl_requests"."superseded_by_hitl_request_id" IS NULL
        AND "hitl_requests"."superseded_by_run_id" IS NULL
      ) OR (
        "hitl_requests"."kind" = 'agent_question'
        AND (
          (
            "hitl_requests"."superseded_at" IS NULL
            AND "hitl_requests"."superseded_by_hitl_request_id" IS NULL
            AND "hitl_requests"."superseded_by_run_id" IS NULL
          ) OR (
            "hitl_requests"."superseded_at" IS NOT NULL
            AND (
              ("hitl_requests"."superseded_by_hitl_request_id" IS NOT NULL AND "hitl_requests"."superseded_by_run_id" IS NULL)
              OR ("hitl_requests"."superseded_by_hitl_request_id" IS NULL AND "hitl_requests"."superseded_by_run_id" IS NOT NULL)
              OR (
                "hitl_requests"."flow_node_attempt_id" IS NOT NULL
                AND "hitl_requests"."responded_at" IS NULL
                AND "hitl_requests"."superseded_by_hitl_request_id" IS NULL
                AND "hitl_requests"."superseded_by_run_id" IS NULL
              )
            )
          )
        )
      ) OR (
        "hitl_requests"."kind" = 'permission'
        AND "hitl_requests"."superseded_at" IS NOT NULL
        AND "hitl_requests"."superseded_by_hitl_request_id" IS NOT NULL
        AND "hitl_requests"."superseded_by_run_id" IS NULL
        AND "hitl_requests"."responded_at" IS NULL
        AND coalesce("hitl_requests"."schema"->'agentPrompt'->>'version', '') = '1'
      ));