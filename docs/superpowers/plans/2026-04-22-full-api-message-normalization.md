# Full API Message Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `cc-gateway`'s `/v1/messages` outbound message preparation up to Claude Code parity by normalizing message order, cleaning incompatible blocks, and validating/repairing tool-use pairing before forwarding upstream.

**Architecture:** Add a dedicated normalization module that operates on the API-bound `messages` array after identity rewrite but before final serialization. The gateway will run a full outbound message pipeline: normalize message ordering/content, then validate and pair `tool_use`/`tool_result`, then forward the cleaned payload to Anthropic while preserving request-shape classification and request logging.

**Tech Stack:** TypeScript, Node.js, existing gateway rewrite pipeline, repo-local test harness in `tests/*.test.ts`

---

## File Map

- Create: `src/api-message-normalizer.ts`
  Own the Claude-Code-aligned outbound message cleanup pipeline for `/v1/messages`.
- Modify: `src/rewriter.ts`
  Invoke the new normalizer from `rewriteMessagesBody()` after metadata rewrite and before CCH/billing/disguise finalization.
- Modify: `tests/rewriter.test.ts`
  Add focused tests covering merged user messages, tool_result hoisting, caller stripping, orphaned thinking cleanup, system-reminder smooshing, and strict tool pairing outcomes.
- Modify: `package.json`
  Add the new/expanded test file to the `npm test` script if needed.

### Task 1: Add Normalizer Test Coverage

**Files:**
- Modify: `/path/to/cc-gateway/tests/rewriter.test.ts`

- [ ] **Step 1: Write failing tests for tool_result hoisting and user-message merge**

Add tests that assert:
- adjacent user messages become one user turn
- `tool_result` blocks move to the front of merged user content
- text seams get `\n` inserted

- [ ] **Step 2: Run test file to verify the new tests fail**

Run: `npx tsx tests/rewriter.test.ts`
Expected: FAIL with missing normalization behavior.

- [ ] **Step 3: Write failing tests for assistant-side cleanup**

Add tests that assert:
- `tool_use.caller` is stripped when present
- trailing thinking-only/whitespace-only assistant messages are removed or normalized
- empty assistant content gets a placeholder text block

- [ ] **Step 4: Run test file to verify the new tests fail**

Run: `npx tsx tests/rewriter.test.ts`
Expected: FAIL on assistant normalization expectations.

- [ ] **Step 5: Write failing tests for tool pairing and system-reminder cleanup**

Add tests that assert:
- orphaned `tool_result` blocks at conversation head are removed
- missing `tool_result` after `tool_use` is detected/repaired according to gateway policy
- `<system-reminder>` text siblings are folded into the last `tool_result`
- `is_error=true` tool results end up text-only

- [ ] **Step 6: Run test file to verify the new tests fail**

Run: `npx tsx tests/rewriter.test.ts`
Expected: FAIL on pairing and system-reminder expectations.

### Task 2: Build the Standalone Message Normalizer

**Files:**
- Create: `/path/to/cc-gateway/src/api-message-normalizer.ts`

- [ ] **Step 1: Add message/block type helpers and exported entrypoint**

Implement a focused module with:
- message content helpers
- `normalizeMessagesForAPI(messages, tools)` exported function
- internal helpers for user/assistant/attachment-ish transformations

- [ ] **Step 2: Implement user-message normalization**

Include logic for:
- normalizing string user content into text blocks
- merging adjacent user messages
- hoisting `tool_result` blocks to the front
- joining adjacent text seams with `\n`

- [ ] **Step 3: Implement assistant-message normalization**

Include logic for:
- stripping unsupported `caller` from `tool_use`
- merging adjacent assistant chunks when appropriate
- filtering orphaned thinking-only / whitespace-only assistant messages
- ensuring non-empty assistant content

- [ ] **Step 4: Implement tool-result content cleanup**

Include logic for:
- folding `<system-reminder>` siblings into the last `tool_result`
- forcing `is_error=true` tool results to contain only text
- preserving regular user text that should remain outside tool results

- [ ] **Step 5: Implement tool-use/tool-result pairing validation/repair**

Include logic for:
- stripping orphaned leading `tool_result`
- detecting duplicate `tool_use`
- detecting missing or duplicate `tool_result`
- applying the gateway’s chosen full-policy behavior consistently to outbound payloads

- [ ] **Step 6: Keep the module dependency-light**

Do not pull in UI-only or transcript-only concepts. The normalizer should only depend on API-bound message structure and tiny local helpers so it can be run safely inside the gateway rewrite path.

### Task 3: Wire the Normalizer into the Rewrite Pipeline

**Files:**
- Modify: `/path/to/cc-gateway/src/rewriter.ts`

- [ ] **Step 1: Import the new normalizer into `rewriter.ts`**

Add a narrow import near the existing request-shape / disguise imports.

- [ ] **Step 2: Run normalization inside `rewriteMessagesBody()`**

Apply the normalizer to `body.messages` only for `/v1/messages` non-count-token requests, after metadata rewrite and before billing-header/CCH finalization.

- [ ] **Step 3: Preserve existing identity and disguise behavior**

Do not regress:
- metadata.user_id rewrite
- billing header injection
- CCH attestation
- CC disguise validation/injection

- [ ] **Step 4: Keep logging/debuggability intact**

If normalization materially changes the outbound message structure, emit concise debug logs so future 400s can be explained from gateway logs without dumping raw sensitive content.

### Task 4: Align Tests and Test Runner

**Files:**
- Modify: `/path/to/cc-gateway/tests/rewriter.test.ts`
- Modify: `/path/to/cc-gateway/package.json`

- [ ] **Step 1: Ensure the test file exercises the new module through `rewriteBody()`**

The main assertions should go through the public rewrite path, not only direct helper calls, so the real pipeline is covered.

- [ ] **Step 2: Add any direct unit tests needed for hard-to-reach helpers**

If one or two edge cases are difficult to reach through `rewriteBody()`, expose a narrow test-only helper export from the new module rather than duplicating pipeline logic in tests.

- [ ] **Step 3: Update the package test script if the new coverage file is separate**

If a new test file is added, include it in `package.json`’s `test` script.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `npx tsx tests/rewriter.test.ts`
Expected: PASS

- [ ] **Step 5: Run the repo test suite**

Run: `npm test`
Expected: PASS for the existing suite plus the new normalization coverage.

### Task 5: Final Verification

**Files:**
- Modify only if verification reveals a real bug

- [ ] **Step 1: Re-check the two production failure shapes against the new behavior**

Verify the new normalizer handles the logged classes of failures:
- mixed `tool_result` + extra text after interrupted tool flow
- assistant content containing stale `tool_use` / extra sibling text

- [ ] **Step 2: Verify no regressions in request logging**

Confirm the gateway still logs normalized `request_body_out` and headers cleanly for admin inspection.

- [ ] **Step 3: Record the verification commands and outcomes**

Capture the exact commands run and whether they passed before reporting completion.

## Self-Review

- Spec coverage: this plan covers full outbound normalization, pairing, cleanup, and integration into the gateway rewrite path.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: the plan consistently treats the work as API-bound `messages` normalization in `src/api-message-normalizer.ts` plus integration in `src/rewriter.ts`.

Plan complete and saved to `docs/superpowers/plans/2026-04-22-full-api-message-normalization.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
