# Lane Done Protocol

1. Before claiming done, the `cataly-lane` worker verifies every `Done =` signal itself using `cataly_done_check` and checks that git has no unintended uncommitted tracked files or unpushed commits.
2. The worker calls `cataly_lane_claim_done` with concrete live evidence (merge SHA, test counts, file path, URL) and stops starting new work.
3. This starts a grace window (default 5 minutes). During this window:
   - The lead may inspect the result (or invoke `cataly-reviewer`) and call `cataly_lane_verify_close` immediately, or
   - Reject the claim with `cataly_lane_object_done` and concrete reasons.
4. Once the grace window expires, `cataly_lane_sweep` runs `cataly_lane_verify_close` automatically:
   - If all `Done =` signals and git checks pass -> status transitions to `verified-done` -> `closed`.
   - If any check fails -> status transitions to `not-done` with exact failure reasons, and the lane must fix every reason and claim again.
