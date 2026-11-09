# AGENTS.md

Instructions for AI coding agents working in this repo.

## What this is
Klero: exactly-once payments for AI agents. It started on Hedera (tag `pre-hackathon`) and is being ported to **NEAR** for
NEAR HACKATHON (deadline 2026-11-14 23:59 UTC). Only NEAR work after the baseline is judged. The plan is
`docs/planning/near-port-plan.md`, and progress is in `HISTORY.md`.

## Layout
| Path | What |
| --- | --- |
| `contracts/klero` | Rust NEAR contract: referee + escrow. Core of the submission |
| `contracts/fusd` | NEP-141 test token |
| `backend/` | pnpm monorepo (Node ≥ 22): api, provider, facilitator, agents, cli, mcp. Still Hedera-wired except the NEAR scripts |
| `backend/scripts/bootstrap-near.ts`, `smoke-near.ts` | NEAR testnet setup and live proof |
| `backend/deployments/near-testnet.json` | current testnet deployment (public ids only) |
| `frontend/` | Next.js app (see `frontend/AGENTS.md`) |
| `docs/proof-near.md` | verified NEAR output; README claims must match it |

## Commands
- Contract tests: `cd contracts && AWS_LC_SYS_PREBUILT_NASM=1 cargo test`
- Contract wasm: `cd contracts && cargo build --release --target wasm32-unknown-unknown`
- Backend deps: `cd backend && corepack pnpm install`
- NEAR setup / proof: `corepack pnpm bootstrap:near`, `corepack pnpm smoke:near`
- Rust is at `~/.cargo/bin` (add to PATH in new shells). Toolchain: stable MSVC.

## Rules
- After every change, update **HISTORY.md** (what and why, with the commit hash), **README.md** (the NEAR section must
  only claim what is verified), and this file if layout or commands change.
- Never commit `.secrets/` or `.env`. Keys only in `.secrets/near-testnet-keys.json` (git-ignored).
- Testnet only. Never sign on mainnet or spend real funds.
- Don't push, make the repo public, post on X or submit the hackathon form without the human's explicit yes.
- Keep the Hedera code working unless the plan's cut list says otherwise.
- The NEAR library is `near-api-js` 7.x (`new Account(id, provider, keyString)`, `callFunction`/`callFunctionRaw`).
  Check its types before assuming older APIs.
