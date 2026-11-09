// Live proof on NEAR testnet:
//   1. three agents of one human race to claim the same job (each signs with its claim-only key)
//   2. only the winner escrows; the provider settles → PAID, exactly one payment
//   3. a second job is escrowed with a 30 s deadline, never settled, then voided → refund
// Usage: pnpm smoke:near
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, getTransactionLastResult, type KeyPairString } from 'near-api-js';

const d = JSON.parse(readFileSync('deployments/near-testnet.json', 'utf8'));
const keys: Record<string, KeyPairString> = JSON.parse(readFileSync('.secrets/near-testnet-keys.json', 'utf8')).keys;
const provider = new JsonRpcProvider({ url: d.rpc });
const TGAS = 1_000_000_000_000n;
const tx = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;
const view = <T>(method: string, args: Record<string, unknown>) =>
  provider.callFunction({ contractId: d.contractId, method, args }) as Promise<T>;
const short = (a: string) => a.split('.')[0];
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

const jobKeyOf = (label: string) =>
  createHash('sha256').update(`${d.human.humanHash}|transcribe|${label}:${Date.now()}`).digest('hex');

async function call(signer: Account, contractId: string, methodName: string, args: object, deposit = 0n) {
  const r = await signer.callFunctionRaw({ contractId, methodName, args, deposit, gas: 50n * TGAS });
  return { hash: r.transaction.hash as string, result: getTransactionLastResult(r as never) };
}

async function race(jobKey: string, providerName: string) {
  const prov = d.providers[providerName].accountId;
  const results = await Promise.all(
    d.agents.map(async (a: string) => {
      const claimer = new Account(a, provider, keys[`${a}#claim`]); // claim-only key
      const r = await call(claimer, d.contractId, 'claim', { job_key: jobKey, round: 0, provider: prov });
      console.log(`[${short(a)}] claim → won=${r.result}  ${tx(r.hash)}`);
      return { agent: a, won: (r.result as unknown) === true };
    }),
  );
  const winners = results.filter((r) => r.won);
  if (winners.length !== 1) throw new Error(`expected exactly 1 winner, got ${winners.length}`);
  return winners[0].agent as string;
}

async function escrow(winner: string, jobKey: string, amount: string, ttl_s: number) {
  const full = new Account(winner, provider, keys[winner]);
  const r = await call(
    full,
    d.token.id,
    'ft_transfer_call',
    { receiver_id: d.contractId, amount, msg: JSON.stringify({ job_key: jobKey, round: 0, ttl_s }) },
    1n,
  );
  console.log(`[${short(winner)}] escrowed ${Number(amount) / 1e6} FUSD  ${tx(r.hash)}`);
}

const bal = async (id: string) => BigInt(await provider.callFunction({ contractId: d.token.id, method: 'ft_balance_of', args: { account_id: id } }) as string);

// ---------- 1 + 2: race, escrow, settle ----------
console.log('\n=== Run 1: three agents, one job → one payment ===');
const job1 = jobKeyOf('meeting.mp3');
const premium = d.providers['scribe-premium'].accountId;
const premiumBefore = await bal(premium);
const winner = await race(job1, 'scribe-premium');
console.log(`winner: ${short(winner)}`);
await escrow(winner, job1, '2000000', 120);
const intent1 = `${job1}:0`;
console.log(`state: ${await view('get_intent_state', { intent_id: intent1 })}`);
const providerAcct = new Account(premium, provider, keys[premium]);
const s = await call(providerAcct, d.contractId, 'settle', { intent_id: intent1 });
console.log(`[scribe-premium] settle  ${tx(s.hash)}`);
console.log(`state: ${await view('get_intent_state', { intent_id: intent1 })}`);
console.log(`provider received: ${Number((await bal(premium)) - premiumBefore) / 1e6} FUSD (payments = 1)`);

// ---------- 3: escrow then void ----------
console.log('\n=== Run 2: payment never settled → provably VOID ===');
const job2 = jobKeyOf('standup.mp3');
const w2 = await race(job2, 'scribe-b');
const before = await bal(w2);
await escrow(w2, job2, '40000', 30);
const intent2 = `${job2}:0`;
console.log(`state: ${await view('get_intent_state', { intent_id: intent2 })} (deadline in 30 s, provider stays silent)`);
while ((await view('get_intent_state', { intent_id: intent2 })) !== 'EXPIRED') await sleep(3000);
console.log(`state: EXPIRED → anyone may void`);
const stranger = new Account(d.operatorId, provider, keys[d.operatorId]);
const v = await call(stranger, d.contractId, 'void_intent', { intent_id: intent2 });
console.log(`void  ${tx(v.hash)}`);
console.log(`state: ${await view('get_intent_state', { intent_id: intent2 })}`);
console.log(`refund to ${short(w2)}: balance back to ${Number(await bal(w2)) / 1e6} FUSD (was ${Number(before) / 1e6} before escrow)`);
const job = await view<{ round: number; status: string }>('get_job', { job_key: job2 });
console.log(`job reopened: round ${job.round}, ${job.status}`);
