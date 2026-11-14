import { createJobDiscovery } from './job-discovery.js';
// Phoebe providers on NEAR: one server hosts scribe-a, scribe-b and scribe-premium.
//
// Payment rule: pay on delivery. The agent's FUSD sits in the Phoebe contract's escrow. The provider checks the
// escrow on-chain, does the work, and only then calls `settle`. If the work fails or runs past the deadline, the
// provider never settles and anyone can void the intent, which refunds the agent. Money moves at most once.
//
// Usage: pnpm dev:providers:near   (port 4050)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { PhoebeNear, intentIdOf, loadNearKeys, nearblocksTx } from '@klero/near';
import { llm, LLM_MODEL } from '@klero/near/llm';
import { GoogleGenAI } from '@google/genai';

const near = new PhoebeNear();
const discovery = createJobDiscovery([...new Set([near.d.contractId, ...(near.d.previousContracts ?? [])])]);
const gemini = new GoogleGenAI({
  apiKey: process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY,
});

const keys = loadNearKeys();
const PUBLIC_URL = (process.env.PROVIDERS_PUBLIC_URL ?? 'http://localhost:4050').replace(/\/$/, '');
const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'provider', 'public', 'sample-meeting.mp3');
const DEADLINE_MARGIN_NS = 10n * 1_000_000_000n; // don't start a settle this close to the deadline
const NAMES: Record<string, string> = { 'scribe-a': 'Scribe A', 'scribe-b': 'Scribe B', 'scribe-premium': 'Scribe Premium' };

type Result = { transcript: string; summary: string; outputHash: string; mode: 'llm' | 'stub' };
type Done = { jobKey: string; round: number; providerId: string; result: Result; settleTx: string; paidBy: string };
const done = new Map<string, Done>(); // jobKey → delivered result
const inflight = new Map<string, Promise<Done>>(); // intentId → work in progress (idempotency)

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
// Demo of the failure path: PROVIDERS_FAIL_ONCE=scribe-b makes that provider crash on its next job, after the
// escrow but before delivery. It never settles, so the agent voids after the deadline and gets refunded.
const failOnce = new Set((process.env.PROVIDERS_FAIL_ONCE ?? '').split(',').filter(Boolean));

async function work(audio: Uint8Array): Promise<Result> {
  if (!llm) {
    const transcript = `[stub transcript: no LLM key configured] ${audio.byteLength} bytes of audio, sha256 ${sha256(audio).slice(0, 16)}…`;
    const summary = '- stub summary (set LLM_API_KEY for a real transcript)';
    return { transcript, summary, outputHash: sha256(transcript + summary), mode: 'stub' };
  }
  
const tr = await gemini.models.generateContent({
  model: LLM_MODEL,
  contents: [{
  role: 'user',
  parts: [
    {
      text: 'Transcribe this audio accurately. Return only the spoken words, preserving the original language.'
    },
    {
      inlineData: {
        mimeType: 'audio/mp3',
        data: Buffer.from(audio).toString('base64'),
      },
    },
  ],
}],
});

const transcript = tr.text?.trim() ?? '';
if (!transcript) throw new Error('Gemini returned an empty transcript');

  const chat = await llm.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: 'Summarize this meeting transcript as 3-6 short bullet points: decisions first, then action items with owners.' },
      { role: 'user', content: transcript.slice(0, 24_000) },
    ],
  });
  const summary = chat.choices[0]?.message?.content?.trim() ?? '';
  return { transcript, summary, outputHash: sha256(transcript + summary), mode: 'llm' };
}

const app = Fastify({ logger: { level: 'info' } });
app.addHook('onRequest', async (_request, reply) => {
  reply.header('Access-Control-Allow-Origin', 'http://localhost:3000');
});
const err = (code: string, message: string, extra: object = {}) => ({ error: { code, message }, ...extra });

app.get('/jobs', async () => discovery.list());
app.get('/health', async () => ({ ok: true, contract: near.d.contractId, llm: llm ? 'on' : 'stub' }));
app.get('/sample-meeting.mp3', async (_req, reply) => reply.type('audio/mpeg').send(readFileSync(SAMPLE)));

/** Service directory: the three providers, their prices and payout accounts. */
app.get('/providers', async () =>
  Object.entries(near.d.providers).map(([providerId, p]) => ({
    providerId,
    name: NAMES[providerId] ?? providerId,
    price: p.price,
    payTo: p.accountId,
    endpoint: `${PUBLIC_URL}/${providerId}/jobs`,
  })),
);

app.post<{ Params: { providerId: string }; Body: { jobKey: string; round: number; agent: string; audioUrl: string; inputHash: string } }>(
  '/:providerId/jobs',
  async (req, reply) => {
    const { providerId } = req.params;
    const me = near.d.providers[providerId];
    if (!me) return reply.code(404).send(err('UNKNOWN_PROVIDER', providerId));
    const { jobKey, round, agent, audioUrl, inputHash } = req.body ?? ({} as never);
    if (!jobKey || round === undefined || !agent || !audioUrl || !inputHash) return reply.code(400).send(err('BAD_REQUEST', 'missing fields'));

    // 1. fence: the on-chain referee must name this agent and this provider for this round
    const job = await near.job(jobKey);
    if (!job) return reply.code(409).send(err('NO_CLAIM', 'no claim on-chain for this job'));
    if (job.round !== round) return reply.code(409).send(err('STALE_ROUND', `job is in round ${job.round}`));
    if (job.winner !== agent) return reply.code(409).send(err('NOT_WINNER', `round winner is ${job.winner}`));
    if (job.provider !== me.accountId) return reply.code(409).send(err('WRONG_PROVIDER', `round was claimed for ${job.provider}`));

    const intentId = intentIdOf(jobKey, round);
    const prior = done.get(jobKey);
    if (prior && prior.round === round) return reply.send(prior); // idempotent replay

    // 2. payment: is the escrow there?
    const state = await near.intentState(intentId);
    if (state === null) {
      // x402-style challenge: pay into escrow, then call again
      return reply.code(402).send(
        err('PAYMENT_REQUIRED', 'escrow the price on the Phoebe contract, then retry', {
          accepts: { token: near.d.token.id, amount: me.price, payTo: me.accountId, escrow: near.d.contractId, msg: { job_key: jobKey, round, ttl_s: 120 } },
        }),
      );
    }
    if (state !== 'PENDING' && state !== 'SETTLING') return reply.code(409).send(err('INTENT_' + state, `intent is ${state}`));
    const intent = (await near.intent(intentId))!;
    if (BigInt(intent.amount) < BigInt(me.price)) return reply.code(402).send(err('UNDERPAID', `escrow ${intent.amount} < price ${me.price}`));

    // 3. do the work once per intent, then settle
    let p = inflight.get(intentId);
    if (!p) {
      p = (async () => {
        const res = await fetch(audioUrl);
        if (!res.ok) throw new Error(`audio download ${res.status}`);
        const audio = new Uint8Array(await res.arrayBuffer());
        if (`sha256:${sha256(audio)}` !== inputHash) throw new Error('inputHash mismatch');
        if (failOnce.delete(providerId)) throw new Error('chaos: provider crashed after escrow, before delivery');
        const result = await work(audio);

        // 4. re-fence at the execution point: still escrowed, still before the deadline?
        const it = (await near.intent(intentId))!;
        const nowNs = BigInt(Date.now()) * 1_000_000n;
        if (it.status !== 'Escrowed') throw new Error(`intent became ${it.status}`);
        if (nowNs + DEADLINE_MARGIN_NS > BigInt(it.deadline_ns)) throw new Error('too close to deadline: not settling, agent will be refunded');

        const s = await near.settle(near.account(me.accountId, keys[me.accountId]!), intentId);
        const after = await near.settledState(intentId);
        if (after !== 'PAID') throw new Error(`settle did not land: ${after}`);
        req.log.info(`settled ${intentId} → PAID ${nearblocksTx(s.hash)}`);
        const d: Done = { jobKey, round, providerId, result, settleTx: s.hash, paidBy: agent };
        done.set(jobKey, d);
        return d;
      })().finally(() => inflight.delete(intentId));
      inflight.set(intentId, p);
    }
    try {
      return reply.send(await p);
    } catch (e) {
      req.log.warn({ intentId, err: String(e) }, 'job failed: not settled');
      return reply.code(502).send(err('NOT_DELIVERED', String(e), { refund: 'intent was not settled; void it after the deadline' }));
    }
  },
);

/** Losers fetch the winner's result. Only agents linked to the same human as the job may read it. */
app.get<{ Params: { providerId: string; jobKey: string }; Querystring: { agent?: string } }>('/:providerId/jobs/:jobKey', async (req, reply) => {
  const d = done.get(req.params.jobKey);
  if (!d || d.providerId !== req.params.providerId) return reply.code(404).send(err('NOT_READY', 'no delivered result yet'));
  const agent = req.query.agent;
  const [job, link] = await Promise.all([near.job(req.params.jobKey), agent ? near.link(agent) : null]);
  if (!job || !link || !link.active || link.human !== job.human) return reply.code(403).send(err('FORBIDDEN', 'agent is not linked to this job’s human'));
  return d;
});

discovery.start();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PROVIDERS_PORT ?? 4050) });
