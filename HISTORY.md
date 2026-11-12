# History

What changed, newest first. Hackathon window: 2026-10-19 → 2026-11-14 23:59 UTC. Baseline: tag `pre-hackathon`.

## 2026-11-12: README is NEAR-only
- README.md rewritten for the judges: what it does, how it works, security model, what is verified (from `docs/proof-near.md`),
  how to run and audit it, repo layout, limits, and origin. The Hedera-era README is archived as `docs/hedera-readme.md`,
  with its links fixed. The origin disclosure (Q-002/Q-003) is kept in an "Origin" section.
- Fixed a claim: approvals were described as "given by the human through World ID"; every recorded run used manual mode.
- Checked: every relative link resolves; claims match the code (22 tests, deadline re-check, Fastify).

## 2026-11-12: repo renamed to Phoebe-NEARHack
- GitHub repo `hackerjose25/Klero-NEAR` → `hackerjose25/Phoebe-NEARHack`. The git remote and every link (README, submission text, `/near`,
  landing footer and buttons) point to the new URL. GitHub redirects the old one. Earlier HISTORY entries keep the old name.

## 2026-11-12: "moonlight" color theme
- Phoebe is the Titaness of radiance and the moon, so the cream + neon-lime palette became moon silver + NEAR mint: `#d3fb43` → `#00ec97`,
  `#f1efe2` → `#eef0f7`, `#dbdac8` → `#d5d9e8`, `#e8e6d6` → `#e3e6f0` (300 values in 34 files: Webflow CSS, components, SVGs, manifest).
  Black ink is unchanged, so contrast holds.
- The logo mark, the PNG embedded in the logo SVGs, the app icons and the favicons were recolored pixel by pixel (lime → mint, shading kept).

## 2026-11-12: renamed Klero → Phoebe
- Every name people see is now Phoebe: the website, logos, the page titles and manifest, the terminal output (`phoebe@`, "Phoebe events"),
  the CLI (`phoebe`), docs, the submission text, and the licence holder. Internal code uses `PhoebeNear`.
- Kept as `klero` on purpose: the testnet accounts (`klero-v2.klero-mw8x6bn1.testnet`, …), the contract's event standard and memos
  (changing them means a redeploy and redoing every proof), the `@klero/*` workspace package names, asset file names, the repo URL,
  raw output in `docs/proof-near.md`, and the Hedera-era docs. README says "formerly Klero".
- Checked: backend typecheck clean, frontend builds, `pnpm audit:near` passes (4 jobs, 33 checks).
- Follow-up (`f43f0a0`): the hero's letter tiles still spelled K-L-E-R-O, because the rename matched whole words only. They now spell P-H-O-E-B-E (six tiles, alternating colors).

## 2026-11-12: no traces of the old project in what the demo shows
- The NEAR commands (`agents:near`, `dev:providers:near`, `dev:approver:near`, `audit:near`, `bootstrap:near`, `smoke:*:near`) run tsx
  directly with `scripts/load-env.mjs`. It loads `backend/.env` only if it exists, so the `../../.env not found` warning is gone, and
  no `forkos@` package banner is printed. The root package is renamed `klero`, and so is the CLI (`klero`).
- The `/near` page and the landing page no longer mention Hedera. The origin is still disclosed in README.md and the submission
  text, because the hackathon rules (Q-002/Q-003) require it.
- Checked: providers start clean; `pnpm audit:near` prints only Klero output (4 jobs, 33 checks, all passed). Frontend builds.

## 2026-11-12: landing page rewritten for NEAR (same design)
- Reverted the previous change (`1764623`), which had replaced the landing with the `/near` page. The human wanted the original UI kept.
- `/` is the original landing with every Hedera/World claim replaced by its NEAR counterpart: contract claim, escrow with a deadline,
  PAID/VOID, on-chain cap, claim-only keys, pay on delivery, `pnpm audit:near`. Logos and the SVG illustrations were updated the same
  way. Buttons go to `/near`, and the footer links to this repo, the proof and NearBlocks. The baseline column notes it was measured in the Hedera version.
- Why: judges see one consistent NEAR story, in the original design.

## 2026-11-12: `/near` web page (`4e4ffa3`)
- `frontend/app/near`: a standalone page that reads the v2 (and v1) contract from the browser over public RPC: each proof job's rounds
  with PAID / VOID / PENDING (with a deadline countdown) / NO ESCROW, payer → provider, amount, the human's on-chain cap, NearBlocks
  links, and a lookup for any job key. The landing header links to it ("LIVE ON NEAR"). `next build` passes; RPC reads checked by hand.
- Why: the public site only showed Hedera. Judges need to see the NEAR state without running anything.

## 2026-11-12: independent NEAR audit (`pnpm audit:near`)
- `apps/cli/src/audit-near.ts`, command `audit-near`: lists the contract and token transactions from NearBlocks v3 (v1 is retired on
  testnet), reads receipt logs from an archival RPC (the regular RPC had already pruned 3-day-old txs), replays the events, and checks
  every job against token transfers and the contract views. RPCs are tried in order, because FastNEAR's archival endpoint returns 429 under load.
- Found while testing: with a wrong token, the escrows were missing and the audit still passed. Added `replay-complete`, which asks the
  contract for each round's intent. That run now fails, as it should.
- Result: v2 3 jobs / 25 checks, v1 5 jobs / 42 checks, all passed (`docs/proof-near.md`).
- Why: "anyone can check" needed a tool that doesn't trust our servers.

## 2026-11-12: submission docs for NEAR (`fdf40b8`)
- `docs/submission/description.md` rewritten for NEAR. It only claims what `docs/proof-near.md` shows, and says what is not verified (World ID, LLM, web dashboard). The Hedera version moved to `description-hedera.md`.
- `docs/demo-video.md` is now a 60–90 s NEAR script. The Hedera script moved to `demo-video-hedera.md`.
- Why: the old texts described only Hedera, and the judges review the NEAR integration.

## 2026-11-09: Day 4, on-chain spend cap + human approval
- Contract v2: per-human `set_cap`, operator-only one-shot `approve_overcap(job, round, max_amount)`, enforced in
  `ft_on_transfer` (an over-cap escrow with no matching approval panics, so the token refunds the payer). Views `get_cap`,
  `get_approval`. 6 new tests (22 total). Deployed as a new account `klero-v2.klero-mw8x6bn1.testnet`, because the state layout
  changed. v1 is kept as history.
- Bootstrap: v2 contract, the human's cap (1 FUSD), one claim-only key per contract (`<agent>#claim@<contract>`, checked
  on-chain, not just in the local file), and a faucet top-up (a throwaway faucet account deleted into the operator).
- `services/approver-near` (`pnpm dev:approver:near`, port 4060): checks on-chain that the agent won the round and the price is
  over the cap, then runs a World ID device flow. It verifies the ID token (issuer, audience, freshness) and that the same World
  identity approves every time (enrolled on first use, stored as a salted hash in `.secrets/`), then calls `approve_overcap`.
  A deny or timeout calls `abandon_round` (no money moved). Without World credentials it runs a clearly labelled manual mode.
- Agents: an over-cap price asks the approver, prints the link, and waits; on deny they retry in the next round.
  `NEAR_AUTO_APPROVE` is removed. `FORCE_PROVIDER` is for demos.
- `scripts/smoke-cap-near.ts` (`pnpm smoke:cap:near`): proof that the contract refuses an unapproved over-cap escrow.
- Bug found and fixed: the provider read the intent state before the settle callback had run, saw `SETTLING`, and reported
  failure, although the payment completed (2 FUSD paid once, result not delivered to the agents). Calls now wait for `FINAL`,
  and readers poll past `SETTLING`/`VOIDING`. A rerun delivered correctly.
- Read calls retry on network errors (a public RPC reset crashed one run's final summary).
- Verified on testnet (`docs/proof-near.md`): unapproved over-cap escrow refused; deny → round abandoned; approve → escrow →
  delivered, 1 payment. Approvals ran in manual mode (no World credentials yet).

## 2026-11-09: Day 3, agents and providers run on NEAR
- `packages/near` (`@klero/near`): `KleroNear` client (claim, escrow via `ft_transfer_call`, settle, void, views), deployment and
  key loaders, and an optional OpenAI-compatible LLM (`LLM_API_KEY` / `LLM_BASE_URL`, e.g. NEAR AI Cloud).
- `services/provider-near`: one server for scribe-a/b/premium. It serves the provider directory, answers a 402 challenge until
  the escrow exists, fences on the on-chain winner/provider/round, does the work, re-checks the deadline, then settles
  (**pay on delivery**). It is idempotent per intent, and losers fetch the result only if linked to the same human.
  `PROVIDERS_FAIL_ONCE` simulates a crash after escrow.
- `apps/agents/src/run-near.ts` (`pnpm agents:near`): three agents choose (LLM or persona rule), claim with claim-only keys,
  the winner escrows on 402, losers wait for PAID and fetch the result; on non-delivery the winner voids after the deadline
  and the job goes to the next round. A spend cap (1 FUSD) needs approval; `NEAR_AUTO_APPROVE=1` stands in for World ID for now.
- Verified on testnet (`docs/proof-near.md`): the happy path gives 1 payment for 3 agents; a provider crash gives void →
  refund → round 1 → 1 payment.
- Fix: the bootstrap re-run check used a field that doesn't exist (`code_base64`), so a re-run would have tried to redeploy.
- No LLM key is configured locally yet, so these runs used persona rules and stub transcripts.
- Tooling: pnpm 9.15.0 installed globally (the root scripts call `pnpm`).

## 2026-11-09: Day 2, deployed and proven on NEAR testnet (`9801c34`)
- `backend/scripts/bootstrap-near.ts` (`pnpm bootstrap:near`): resumable testnet setup. It creates the operator via the faucet,
  FUSD token, Klero contract, three provider accounts, one human with agents `a`/`b`/`c` as sub-accounts, claim-only
  function-call keys, demo FUSD balances, agent links, and gas top-ups. Keys go to `.secrets/near-testnet-keys.json`
  (git-ignored) the moment each account exists.
- `backend/scripts/smoke-near.ts` (`pnpm smoke:near`): live race → escrow → settle (PAID), and escrow → deadline → void
  (VOID, refunded). Output in `docs/proof-near.md`.
- Deployed: operator `klero-mw8x6bn1.testnet`, contract `klero.klero-mw8x6bn1.testnet`, token `fusd.klero-mw8x6bn1.testnet`
  (`backend/deployments/near-testnet.json`).
- Contracts are built with stripped symbols (wasm ~40% smaller, cheaper storage).
- Problem hit: the first smoke run's escrow failed before sending, because agents had too little NEAR for 100 TGas of
  prepaid gas. No tokens moved. Fixed with 50 TGas and agent top-ups.

## 2026-11-09: Day 1, contracts (`d984650`, `a9fef77`)
- `contracts/klero`: referee + escrow (link agents, first-claim-wins rounds, one intent per job and round with a deadline,
  `settle` → PAID / `void_intent` → VOID, `abandon_round`, NEP-297 events, views). 16 unit tests.
- `contracts/fusd`: NEP-141 test token, 6 dp, owner mint.
- MIT `LICENSE` at the repo root.
- Dev setup on Windows: Rust (MSVC) + VS Build Tools C++ workload; tests need `AWS_LC_SYS_PREBUILT_NASM=1`.

## 2026-11-09: Repo created (`45d2ae8`, tag `pre-hackathon`)
- New repo, seeded with Klero (Hedera) as of commit `1cb9f19` of the original repo. Port plan:
  `docs/planning/near-port-plan.md`.
