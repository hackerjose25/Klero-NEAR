// Three agents of one human buy the same transcription on NEAR. Exactly one pays.
//
//   each agent: pick a provider (LLM, or a persona rule without a key) → claim on the Klero contract
//   winner:     ask the provider (402) → escrow FUSD → provider works, then settles → result
//   losers:     wait for the contract to say PAID → fetch the winner's result
//   if the provider never delivers, the winner voids after the deadline (refund) and the job reopens.
//
// Usage: pnpm agents:near            (providers must be running: pnpm dev:providers:near)
import { createHash } from 'node:crypto';
import { KleroNear, claimKeyId, intentIdOf, loadNearKeys, nearblocksTx, type NearJob } from '@klero/near';
import { llm, LLM_MODEL } from '@klero/near/llm';

const PROVIDERS = (process.env.PROVIDERS_URL ?? 'http://localhost:4050').replace(/\/$/, '');
const APPROVER = (process.env.APPROVER_URL ?? 'http://localhost:4060').replace(/\/$/, '');
const near = new KleroNear();
const keys = loadNearKeys();
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Service = { providerId: string; name: string; price: string; payTo: string; endpoint: string };
const PERSONAS = [
  { text: 'You always pick the cheapest option.', rule: (s: Service[]) => [...s].sort((a, b) => Number(a.price) - Number(b.price))[0]! },
  { text: 'You prefer the provider whose name sounds most reliable; price matters less.', rule: (s: Service[]) => s.find((x) => x.providerId === 'scribe-b') ?? s[0]! },
  { text: 'You prefer the premium option when the meeting might be important.', rule: (s: Service[]) => [...s].sort((a, b) => Number(b.price) - Number(a.price))[0]! },
];

async function choose(persona: (typeof PERSONAS)[number], services: Service[], tag: string): Promise<Service> {
  const forced = process.env.FORCE_PROVIDER && services.find((s) => s.providerId === process.env.FORCE_PROVIDER);
  if (forced) {
    console.log(`[${tag}] FORCE_PROVIDER → ${forced.providerId}`);
    return forced;
  }
  if (!llm) {
    const pick = persona.rule(services);
    console.log(`[${tag}] rule (${persona.text.slice(0, 28)}…) → ${pick.providerId}`);
    return pick;
  }
  const list = services.map((s) => ({ providerId: s.providerId, name: s.name, priceFUSD: Number(s.price) / 1e6 }));
  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `You are a procurement agent. ${persona.text} Reply as JSON {"providerId": "...", "why": "..."}.` },
      { role: 'user', content: `Task: transcribe and summarize a meeting recording. Services: ${JSON.stringify(list)}` },
    ],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as { providerId?: string; why?: string };
  const pick = services.find((s) => s.providerId === parsed.providerId) ?? persona.rule(services);
  console.log(`[${tag}] LLM → ${pick.providerId}: ${parsed.why ?? ''}`);
  return pick;
}

async function waitJob(jobKey: string, until: (j: NearJob) => boolean, timeoutMs = 300_000) {
  const start = Date.now();
  for (;;) {
    const j = await near.job(jobKey);
    if (j && until(j)) return j;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for job');
    await sleep(2000);
  }
}

type Outcome = { agent: string; kind: 'PAID_BY_ME' | 'PAID_BY_OTHER' | 'FAILED'; provider?: string; detail?: string; summary?: string };

async function runAgent(agent: string, i: number, job: { jobKey: string; audioUrl: string; inputHash: string }, services: Service[]): Promise<Outcome> {
  const tag = agent.split('.')[0]!;
  const claimer = near.account(agent, keys[claimKeyId(agent, near.d.contractId)]!); // claim-only key
  const payer = near.account(agent, keys[agent]!);
  const byAccount = Object.fromEntries(services.map((s) => [s.payTo, s]));

  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await near.job(job.jobKey);
    const round = current?.round ?? 0;
    if (current?.status === 'Paid') return fetchResult(agent, tag, job.jobKey, byAccount[current.provider!]!);

    const svc = await choose(PERSONAS[i % PERSONAS.length]!, services, tag);
    const c = await near.claim(claimer, job.jobKey, round, svc.payTo);
    console.log(`[${tag}] claim round ${round} via ${svc.providerId} → ${c.won ? 'WON' : 'lost'}  ${nearblocksTx(c.hash)}`);

    if (!c.won) {
      const j = await waitJob(job.jobKey, (x) => x.status === 'Paid' || x.round > round);
      if (j.round > round) continue; // winner's payment was voided → next round
      return fetchResult(agent, tag, job.jobKey, byAccount[j.provider!]!);
    }

    // winner: the human's spend cap lives on-chain; above it the contract refuses the escrow without an approval
    const cap = await near.cap(near.d.human.humanHash);
    if (cap && BigInt(svc.price) > BigInt(cap)) {
      console.log(`[${tag}] ${Number(svc.price) / 1e6} FUSD is over the on-chain cap of ${Number(cap) / 1e6} FUSD → asking the human`);
      const res = await fetch(`${APPROVER}/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey: job.jobKey, round, amount: svc.price, agent }),
      });
      let a = (await res.json()) as { id: string; mode: string; status: string; reason?: string; userCode?: string; verificationUriComplete?: string; approveTx?: string };
      if (!res.ok) return { agent: tag, kind: 'FAILED', detail: `approver: ${JSON.stringify(a)}` };
      console.log(`[${tag}] approve here (${a.mode === 'world' ? 'World App' : 'MANUAL stand-in, no World ID configured'}): ${a.verificationUriComplete}${a.userCode ? `  code ${a.userCode}` : ''}`);
      while (a.status === 'PENDING') {
        await sleep(2000);
        a = (await (await fetch(`${APPROVER}/approvals/${a.id}`)).json()) as typeof a;
      }
      if (a.status !== 'APPROVED') {
        console.log(`[${tag}] approval ${a.status} (${a.reason ?? ''}) → round abandoned, no money moved`);
        await waitJob(job.jobKey, (x) => x.round > round);
        continue;
      }
      console.log(`[${tag}] approved on-chain  ${nearblocksTx(a.approveTx!)}`);
    }

    const body = { jobKey: job.jobKey, round, agent, audioUrl: job.audioUrl, inputHash: job.inputHash };
    const post = () => fetch(svc.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let r = await post();
    if (r.status === 402) {
      const challenge = (await r.json()) as { accepts: { amount: string } };
      const e = await near.escrow(payer, job.jobKey, round, challenge.accepts.amount, 120);
      console.log(`[${tag}] escrowed ${Number(challenge.accepts.amount) / 1e6} FUSD  ${nearblocksTx(e.hash)}`);
      r = await post();
    }
    const out = (await r.json()) as any;
    if (r.ok) {
      console.log(`[${tag}] delivered + settled  ${nearblocksTx(out.settleTx)}`);
      return { agent: tag, kind: 'PAID_BY_ME', provider: svc.providerId, summary: out.result.summary };
    }

    // not delivered: wait out the deadline, void (refund), next round
    console.log(`[${tag}] provider did not deliver (${out.error?.code}) → waiting for the deadline to void`);
    const intentId = intentIdOf(job.jobKey, round);
    while ((await near.intentState(intentId)) === 'PENDING') await sleep(3000);
    const st = await near.settledState(intentId);
    if (st === 'PAID') continue; // it was delivered after all: next pass fetches the result
    if (st === 'EXPIRED') {
      const v = await near.voidIntent(payer, intentId);
      console.log(`[${tag}] voided → refunded  ${nearblocksTx(v.hash)}`);
    }
  }
  return { agent: tag, kind: 'FAILED', detail: 'too many rounds' };
}

async function fetchResult(agent: string, tag: string, jobKey: string, svc: Service): Promise<Outcome> {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${svc.endpoint}/${jobKey}?agent=${encodeURIComponent(agent)}`);
    if (r.ok) {
      const d = (await r.json()) as any;
      console.log(`[${tag}] received the winner's result from ${svc.providerId}`);
      return { agent: tag, kind: 'PAID_BY_OTHER', provider: svc.providerId, summary: d.result.summary };
    }
    await sleep(1000);
  }
  return { agent: tag, kind: 'FAILED', detail: 'result not available' };
}

// ---------- main ----------
const services = (await (await fetch(`${PROVIDERS}/providers`)).json()) as Service[];
const audioUrl = `${PROVIDERS}/sample-meeting.mp3`;
const audio = new Uint8Array(await (await fetch(audioUrl)).arrayBuffer());
const inputHash = `sha256:${sha256(audio)}`;
// Same human + same input → same jobKey for every agent. A run id keeps repeated demos independent.
const runId = process.env.RUN_ID ?? Date.now().toString(36);
const jobKey = sha256(`klero:job:v1|${near.d.human.humanHash}|transcribe:${runId}|${inputHash}`);
console.log(`job ${jobKey.slice(0, 16)}… (run ${runId}), ${near.d.agents.length} agents, LLM: ${llm ? LLM_MODEL : 'off (persona rules)'}\n`);

const before = await Promise.all(services.map((s) => near.balance(s.payTo)));
const results = await Promise.all(near.d.agents.map((a, i) => runAgent(a, i, { jobKey, audioUrl, inputHash }, services)));
const after = await Promise.all(services.map((s) => near.balance(s.payTo)));

console.log();
console.table(results.map(({ summary, ...r }) => r));
const paid = services.map((s, i) => ({ provider: s.providerId, receivedFUSD: Number(after[i]! - before[i]!) / 1e6 })).filter((x) => x.receivedFUSD > 0);
console.log('payments on-chain this run:', paid.length, JSON.stringify(paid));
const summary = results.find((r) => r.summary)?.summary;
if (summary) console.log('\nsummary every agent received:\n' + summary);
