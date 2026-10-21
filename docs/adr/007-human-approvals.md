# ADR 007: Human approval for commitments

- Status: Accepted
- Date: 2026-10-21

## Context

The team document (§5, §8, §13) requires that "a purchase cannot be committed without the required approval". Before this change the platform only flagged grants above the threshold (`apr: true`). Nothing stopped an agent from committing.

## Decision

1. **Some capabilities commit the organization.** A policy's `commitCapabilities` lists them; the default is `order.confirm`. Above the organization's `approvalThreshold`, the platform issues a grant for one of them **only** against an approval that:
   - is **approved**
   - belongs to the same organization and requesting agent
   - names the same provider, capability and currency
   - covers at least the grant's budget
   - **has not been used**

   The approval is consumed atomically when the grant is issued, so it backs exactly one commitment. Without such an approval the response is `403 approval_required`.
2. **The agent asks; a person decides.** An agent calls `POST /approvals`. Only a member of the requesting organization with the **owner, admin or approver** role can decide, via `POST /approvals/{id}/decision` in the console's Approvals page. Rejecting or requesting changes needs a comment. A decision is final. Requests and decisions are written to the audit log with the deciding user.
3. **Decisions are made on the platform, not on the node.** The approver's identity must be a verified organization member that the platform trusts. A node's operator password isn't enough. The Partner Kit's **Commit order** action:
   - tries to confirm
   - on `approval_required`, files the approval request and shows its status
   - polls for the decision, and confirms automatically once approved
   - surfaces the approver's comment otherwise
4. **Defence in depth on the provider.** The `order.confirm` module (`@pistiva/procurement`) refuses:
   - a grant that needed approval (`apr`) but carries none (`apv`)
   - a grant whose budget doesn't cover the draft's total
   - another requester's draft
   - a draft already confirmed or past its hold date

## Consequences

- The approval is consumed when the grant is issued. If the confirm then fails, for example because the supplier is offline, the operator needs a new approval. That's simpler and safer than re-usable approvals.
- Separation of duties isn't enforced yet: the person who owns the requesting agent may also approve. A policy flag for a second approver can come later.
- Only `order.confirm` is a commitment today. New commitment task types are opted in through the policy, without code changes.
