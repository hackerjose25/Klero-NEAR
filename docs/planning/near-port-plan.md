# Klero → NEAR HACKATHON: port plan

Deadline: **2026-11-14 23:59 UTC**. Today is 2026-11-09, so there are 5 working days.
Rules this plan follows (from HACKATHON.md): Q-002 (a product from another chain is allowed; only the NEAR
integration is judged), Q-003 (separate the new work), Q-010 (testnet is fine), Q-011 (our own NEAR contract is
enough), Q-012 (a demo video is required).

## Goal

The same three-agent demo on **NEAR testnet**: three agents of one human want the same job, a NEAR contract picks
one winner, exactly one payment moves, and anyone can check whether a payment ended PAID or VOID by calling the
contract.

## Why NEAR is a better fit than a straight port

On Hedera, VOID was inferred from network rules: the 120 s tx expiry plus a Mirror Node 404. NEAR transactions stay
valid much longer, so we don't copy that trick. Instead, **the contract escrows the funds and holds the state
machine**:

- `PAID` and `VOID` are contract states. Each payment can make exactly one transition, and the contract enforces it.
- VOID becomes a fact you read from the contract (a view call) instead of something you infer from a 404.
- Agent keys are **function-call access keys** scoped to the Klero contract, so an agent cannot move money anywhere
  else. This is the AI Security track's own hint.
- Each agent gets a **sub-account** of the human (`a.alice.testnet`), which matches the AI Swarms track's hint.

## 1. Repo hygiene (Day 1, ~1 h)

- [ ] Tag the current `main` as `pre-hackathon` (`git tag pre-hackathon 1cb9f19`). The Hedera version is the baseline.
- [ ] Work on the branch `near`. Merge to `main` (or tag `hackathon-submission`) at the end.
- [ ] README: a new top section, "NEAR HACKATHON", that discloses the Hedera origin (Q-002) and links the diff
      `pre-hackathon...hackathon-submission` (Q-003). List libraries used (Q-005).
- [ ] Add a root `LICENSE` file (Q-014). Only `backend/LICENSE` exists today.
- [ ] Note: the Hedera code was written 2026-11-06 onward (inside the window), but count only the NEAR work as judged.

## 2. The contract `contracts/klero` (Days 1–2): the core of the submission

Rust with `near-sdk`, deployed to `klero.<team>.testnet`.

State:
- `links: human_hash -> {agent_account, epoch, active}`
- `jobs: job_key -> {round, winner, status}`
- `intents: intent_id -> {job_key, payer, provider, token, amount, deadline_ns, status}`

Methods:
| Method | Who | Effect |
| --- | --- | --- |
| `link_agent(human_hash, agent, epoch)` | operator (after the World ID check) | registers an agent for a human |
| `claim(job_key, round, provider)` | linked agent | first claim in a round wins; later ones are recorded as losers |
| `ft_on_transfer` (NEP-141 `ft_transfer_call`) | the token contract | the winner escrows the payment and creates the intent with a deadline |
| `settle(intent_id)` | provider / facilitator, before the deadline | pays the provider → `PAID` |
| `void(intent_id)` | anyone, after the deadline | refunds the payer → `VOID` |
| `get_job`, `get_intent`, `get_round` | view | the public audit view |

- Emit NEP-297 event logs (`claim`, `intent`, `settled`, `void`), so the audit CLI can replay history the way it
  replays HCS today.
- Payment token: deploy a test NEP-141 "FUSD" (6 dp) to testnet, the same unit as today. Testnet USDC is a stretch
  goal.
- Contract tests (`near-workspaces`): the double claim, settle twice (rejected), settling after the deadline
  (rejected), void before the deadline (rejected), void after it (refunded).

## 3. Backend chain adapter (Days 2–3)

Keep Hedera working and add NEAR beside it, chosen by `CHAIN=near|hedera`.

| Hedera today | NEAR replacement (new) |
| --- | --- |
| `packages/shared/src/hcs.ts` + `referee.ts` (consensus order) | `packages/near/src/referee.ts`: `claim()` + `get_job` views; `viewJob()` keeps the same `JobView` shape |
| `packages/shared/src/mirror.ts` | `packages/near/src/rpc.ts`: `near-api-js` view calls + tx status |
| `packages/x402-hedera` (`intent`, `payload`, `resolver`) | `packages/x402-near`: build an `ft_transfer_call` intent; `resolveIntent()` reads `get_intent` |
| `scripts/bootstrap-hedera.ts` | `scripts/bootstrap-near.ts`: create sub-accounts, add function-call keys, deploy the token and contract, write `deployments/near-testnet.json` |
| `services/facilitator/src/settle.ts` | calls `settle(intent_id)` on the contract |
| `services/provider/src/fence.ts` | the fence checks `get_job` winner + epoch |
| `apps/cli/src/audit.ts` | `pnpm klero audit --chain near`: replays the contract events |

- Define a small `ChainAdapter` interface (`claim`, `viewJob`, `createIntent`, `settle`, `resolveIntent`) in
  `packages/shared` and route `services/api/src/payer.ts` and `resolver.ts` through it. These are the files where
  the 16 Hedera-SDK imports live.
- Keep the agent logic, the `jobKey` hashing, World ID, policy and approvals unchanged.

## 4. Frontend (Day 4, half day)

- [ ] Explorer links → `testnet.nearblocks.io` (accounts, txs, contract).
- [ ] Dashboard: show the NEAR account, sub-accounts and function-call key scope per agent.
- [ ] Death-clock view reads `get_intent` (PAID / VOID / pending, with the deadline countdown).
- [ ] Redeploy on Vercel; keep it up until 2026-11-25 (Q-012).

## 5. Proof and demo (Day 4–5)

- [ ] Run the three-agent race on NEAR testnet. Record: the claim txs, the winner, the single escrow + settle, and
      the losers receiving the result. Save the raw output to `docs/proof-near.md`.
- [ ] Run one deliberate VOID: an intent that is never settled, voided after the deadline, with the refund visible.
- [ ] Rewrite the README for the AI screeners: "do X → see Y" steps, a one-command local run, and nothing claimed
      that isn't in `proof-near.md`.
- [ ] 60–90 s video: problem (one line) → three agents race → one payment on NearBlocks → VOID refund.
- [ ] X post draft (the human posts it): tag @NEARProtocol and #NEARHackathon, optionally @NearLegion and @NearBuilders.

## 6. Submit (Day 5, by 14 Nov)

- Tracks: `security`, `swarms`, `agents`.
- The human provides: project name, team lead, email, team size, a **mainnet** NEAR payout account, the demo post link
  and consent. The repo must be public first.
- The payload is printed and confirmed before a single POST. Fixes go through `/request-changes` only.

## Schedule

| Day | Date | Done when |
| --- | --- | --- |
| 1 | Mon 9 Nov | tag + branch; contract skeleton with claim/intent/settle/void; token deployed on testnet |
| 2 | Tue 10 Nov | contract tests pass; deployed; `bootstrap-near.ts` creates agents + keys |
| 3 | Wed 11 Nov | the backend runs the full race on NEAR through the adapter |
| 4 | Thu 12 Nov | frontend on NEAR; proof run + VOID run recorded |
| 5 | Fri 13 Nov | README, video, X post; buffer |
| — | Sat 14 Nov | submit with hours to spare (deadline 23:59 UTC) |

## Cut list (if we fall behind, drop from the top)

1. Testnet USDC (keep the test FUSD)
2. The frontend death-clock view (the CLI audit is enough)
3. Keeping Hedera runnable on the `near` branch
4. Stretch, only if ahead: list the provider on Agent Market (market.near.ai); private transcription via NEAR AI Cloud

## Open questions for the team

- Who writes the Rust contract? Does anyone have `near-sdk` experience?
- Payout account: someone needs to create a mainnet `.near` account.
- Is the World ID app still valid for the new demo? (Not chain-specific, so it should be.)
