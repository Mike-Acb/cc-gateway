# Load Balancing Notes

Date: 2026-04-11

Context:
- Current deployment uses `cc-alice` to launch native `claude-code` through `cc-gateway`.
- `cc-alice` forces `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and `CLAUDE_CODE_ATTRIBUTION_HEADER=false`.
- Client -> gateway is API-key mode.
- Gateway -> Anthropic is OAuth subscriber-account mode.

Key conclusions so far:
- The main risk signal is not API-key mode itself. The main risk is multi-account pool behavior making one logical session appear to be carried by multiple upstream subscriber accounts.
- The strongest "distributed request" signal comes from request-level account switching during an active session.
- In the current gateway design, switching accounts also switches outward identity:
  - `metadata.user_id`
  - `x-claude-code-session-id`
  - `User-Agent`
  - `x-app`
  - `x-stainless-*`
- This means account switching is currently exposed at the request surface, not only at the bearer-token layer.

Important constraints from user:
- Load balancing must remain.
- User experience must not obviously degrade.
- "Disable switching" or "remove retry failover" is not an acceptable final strategy.

Current working direction:
- First isolate variables by testing with a single upstream account in the pool.
- Purpose of single-account phase:
  - eliminate cross-account switching as a cause
  - determine whether the remaining request shape still differs too much from native `claude-code`

Open issues already identified:
- `/v1/messages` outer `metadata` is not yet white-listed to only `user_id`.
- Unknown/custom headers are still forwarded by default.
- Potentially leaky headers include:
  - `x-client-app`
  - `x-claude-remote-container-id`
  - `x-claude-remote-session-id`
  - `x-anthropic-additional-protection`
  - arbitrary unknown `x-*`
- Gateway currently rewrites outward identity per account, not per session/persona.

If discussion resumes on load balancing later:
- Revisit whether the right model is:
  - request-level balancing
  - session-level assignment
  - session migration on failure
  - or token-layer balancing with stable outward persona
- Re-check whether the true unacceptable signal is:
  - cross-account switching itself
  - identity switching
  - or both

Short reminder:
- User may later say: "continue discussing load balancing strategy".
- Resume from this note rather than re-deriving the above.

Operational note: verifying debug request logging on deployed gateway
- Confirm latest request rows:
  - Query `request_logs` ordered by `created_at DESC`
  - Check:
    - `request_headers_in IS NOT NULL`
    - `request_headers_out IS NOT NULL`
    - `request_body_out IS NOT NULL`
    - `response_headers IS NOT NULL`
- Example verification query:

```sql
SELECT
  created_at,
  trace_id,
  client_name,
  path,
  request_model,
  response_status,
  oauth_account_name,
  error_message,
  retry_count,
  request_headers_in IS NOT NULL  AS has_request_headers_in,
  request_headers_out IS NOT NULL AS has_request_headers_out,
  request_body_out IS NOT NULL    AS has_request_body_out,
  response_headers IS NOT NULL    AS has_response_headers
FROM request_logs
ORDER BY created_at DESC
LIMIT 5;
```

- If the newest row has all four debug fields present, detailed logging is active.
- Older rows may only have `request_headers_in`; that can be expected if they were created before the new code path was deployed.
- Next step after verification:
  - pull the full row by `trace_id`
  - compare `request_headers_in` vs `request_headers_out`
  - inspect `request_body` vs `request_body_out`
  - if needed, join with `usage_records` by `trace_id`
