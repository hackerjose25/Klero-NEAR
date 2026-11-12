# Phoebe on NEAR: the demo video (60–90 s)

**One idea:** three agents of one human want the same job. The NEAR contract picks one winner, exactly one payment moves, and a
payment that isn't delivered ends **VOID** and is refunded. Anyone can check this on NearBlocks.

Rules: your own voice, no speed-up. Record in scenes and cut the waits. Show at least one NearBlocks transaction readable on screen.

## Set-up (once)

```bash
cd backend
pnpm dev:providers:near      # terminal 1, port 4050
pnpm dev:approver:near       # terminal 2, port 4060
```
Terminal 3 is for the agents (font ≥ 18). Browser tab: https://testnet.nearblocks.io/address/klero-v2.klero-mw8x6bn1.testnet
Do a dry run of `pnpm agents:near` first. If an agent is low on FUSD or NEAR, re-run `pnpm bootstrap:near` (it is resumable).

## Script

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 | Title / README | — | "AI agents pay for things on their own. When a payment drops halfway, or three of your agents buy the same thing, **did you pay once, twice, or not at all?** Phoebe answers that on NEAR." |
| 0:10 | Terminal 3 | `pnpm agents:near` | "Three agents, each a sub-account of one human, with a key that can only call `claim`. They all want the same transcript." |
| 0:20 | Terminal: claim lines | Point at WON / lost | "Each one claims on the Phoebe contract. **The first claim wins.** The others don't pay." |
| 0:30 | Terminal: escrow → settled | Point at the lines | "The winner gets a 402, escrows FUSD in the contract, and the provider is paid **only after it delivers.**" |
| 0:40 | Terminal: summary | Point at `payments on-chain this run: 1` | "Three agents, **one payment**. The losers got the result for free." |
| 0:45 | NearBlocks | Open the settle tx | "It's all public on NearBlocks." |
| 0:50 | Terminal (pre-recorded take with `PROVIDERS_FAIL_ONCE=scribe-b` on the providers) | Point at "voided → refunded" | "If the provider crashes, it never gets paid. After the deadline the escrow is **VOID** and refunded. That's contract state, not a guess, and the job moves on. Still one payment." |
| 1:05 | Terminal (take with `FORCE_PROVIDER=scribe-premium`) | Show the approval link, approve | "Over the human's cap, **the contract itself refuses** unless the human approves that exact payment." |
| 1:20 | README | — | "Phoebe: exactly-once payments for AI agents, on NEAR. **Agents fork. Money doesn't.**" |

If the approver has no World credentials, the link says MANUAL. Say "a local approval page standing in for World ID". Don't call it World ID.

After recording: put the video link in README.md (table at the top) and in the submission.
