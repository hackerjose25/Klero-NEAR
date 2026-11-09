// Klero approver on NEAR: turns a human's World ID approval into an on-chain `approve_overcap`.
//
//   agent (round winner, price over the human's on-chain cap) → POST /approvals
//   approver checks on-chain that the agent won this round, then starts a World ID device flow
//   human opens the link in World App and approves → approver verifies the ID token (issuer, audience,
//   freshness, same human as enrolled) → operator calls approve_overcap(job, round, amount) on the contract
//   agent polls GET /approvals/:id → APPROVED → escrows. The contract rejects an over-cap escrow without it.
//
// Without WORLD_CLIENT_ID/SECRET the approver runs in `manual` mode: the approval link is a local page with
// Approve / Deny buttons. It is labelled as such everywhere; it is a stand-in, not World ID.
//
// Usage: pnpm dev:approver:near   (port 4060)
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { KleroNear, loadNearKeys, nearblocksTx } from '@klero/near';

const near = new KleroNear();
const keys = loadNearKeys();
const operator = near.account(near.d.operatorId, keys[near.d.operatorId]!);
const PUBLIC_URL = (process.env.APPROVER_PUBLIC_URL ?? 'http://localhost:4060').replace(/\/$/, '');
const ISSUER = (process.env.WORLD_ISSUER ?? 'https://auth.world.org').replace(/\/$/, '');
const CLIENT_ID = process.env.WORLD_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.WORLD_CLIENT_SECRET ?? '';
const FRESH_S = Number(process.env.WORLD_FRESH_SECONDS ?? 300);
const MODE: 'world' | 'manual' = CLIENT_ID && CLIENT_SECRET && !CLIENT_ID.startsWith('<') ? 'world' : 'manual';
const APPROVAL_TTL_MS = 10 * 60_000;

// Which World identity is "the human": enrolled on the first successful World approval (trust on first use),
// stored as a salted hash, never the raw sub. Local file, git-ignored.
const ENROLL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.secrets', 'near-world-enrollment.json');
const enrollment: Record<string, string> = existsSync(ENROLL) ? JSON.parse(readFileSync(ENROLL, 'utf8')) : {};
const subHash = (sub: string) => createHash('sha256').update(`klero:world-sub:v1|${ISSUER}|${sub}`).digest('hex');

type Status = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'FAILED';
type Approval = {
  id: string;
  mode: 'world' | 'manual';
  jobKey: string;
  round: number;
  amount: string;
  agent: string;
  human: string;
  status: Status;
  reason?: string;
  approveTx?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  deviceCode?: string;
  interval: number;
  nextPollAt: number;
  startedAt: number;
  expiresAt: number;
};
const approvals = new Map<string, Approval>();

// ---------- World ID (OIDC device flow) ----------
type Discovery = { issuer: string; device_authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
let disco: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function discovery() {
  if (disco) return disco;
  const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`World discovery failed: ${r.status}`);
  disco = (await r.json()) as Discovery;
  jwks = createRemoteJWKSet(new URL(disco.jwks_uri));
  return disco;
}

async function startWorld(a: Approval) {
  const d = await discovery();
  const r = await fetch(d.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: 'openid' }),
  });
  const j = (await r.json()) as Record<string, any>;
  if (!r.ok || !j.device_code) throw new Error(`World device_authorization failed: ${j.error ?? r.status}`);
  a.deviceCode = j.device_code;
  a.userCode = j.user_code;
  a.verificationUri = j.verification_uri;
  a.verificationUriComplete = j.verification_uri_complete ?? j.verification_uri;
  a.interval = j.interval ?? 5;
  a.nextPollAt = Date.now() + a.interval * 1000;
}

async function pollWorld(a: Approval) {
  const d = await discovery();
  const r = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      device_code: a.deviceCode!,
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; id_token?: string };
  if (!j.id_token) {
    if (j.error === 'authorization_pending' || r.status === 503) return void (a.nextPollAt = Date.now() + a.interval * 1000);
    if (j.error === 'slow_down') return void ((a.interval += 5), (a.nextPollAt = Date.now() + a.interval * 1000));
    if (j.error === 'access_denied') return finish(a, 'DENIED', 'declined in World App');
    if (j.error === 'expired_token') return finish(a, 'EXPIRED', 'World code expired');
    return finish(a, 'FAILED', j.error ?? `http_${r.status}`);
  }
  let claims: { sub?: string; auth_time?: number };
  try {
    claims = (await jwtVerify(j.id_token, jwks!, { issuer: d.issuer, audience: CLIENT_ID })).payload as typeof claims;
  } catch (e) {
    return finish(a, 'FAILED', `invalid ID token: ${(e as Error).message}`);
  }
  const nowS = Date.now() / 1000;
  if (!claims.sub) return finish(a, 'FAILED', 'missing sub');
  if (typeof claims.auth_time !== 'number' || claims.auth_time < a.startedAt / 1000 - 5 || nowS - claims.auth_time > FRESH_S) {
    return finish(a, 'FAILED', 'World authentication is not fresh');
  }
  const h = subHash(claims.sub);
  if (!enrollment[a.human]) {
    enrollment[a.human] = h;
    writeFileSync(ENROLL, JSON.stringify(enrollment, null, 2));
    app.log.info(`enrolled World identity for human ${a.human.slice(0, 12)}…`);
  } else if (enrollment[a.human] !== h) {
    return finish(a, 'DENIED', 'a different World ID approved: not this agent’s human');
  }
  await approveOnChain(a);
}

// ---------- on-chain ----------
async function approveOnChain(a: Approval) {
  // re-check right before writing: still this agent's round, still no escrow
  const job = await near.job(a.jobKey);
  if (!job || job.round !== a.round || job.winner !== a.agent) return finish(a, 'FAILED', 'round changed before approval');
  const r = await near.approveOvercap(operator, a.jobKey, a.round, a.amount);
  a.approveTx = r.hash;
  finish(a, 'APPROVED');
  app.log.info(`approved ${a.id} on-chain ${nearblocksTx(r.hash)}`);
}

function finish(a: Approval, status: Status, reason?: string) {
  a.status = status;
  a.reason = reason;
  delete a.deviceCode;
  // No approval → close the round on-chain (no money moved) so the agents can try again.
  if (status !== 'APPROVED') {
    near
      .abandonRound(operator, a.jobKey)
      .then((r) => app.log.info(`round ${a.round} of ${a.jobKey.slice(0, 12)}… abandoned ${nearblocksTx(r.hash)}`))
      .catch((e) => app.log.warn({ err: String(e) }, 'abandon_round failed'));
  }
}

// ---------- HTTP ----------
const app = Fastify({ logger: { level: 'info' } });
const pub = ({ deviceCode, nextPollAt, ...rest }: Approval) => rest;

app.get('/health', async () => ({ ok: true, mode: MODE, contract: near.d.contractId }));

app.post<{ Body: { jobKey: string; round: number; amount: string; agent: string } }>('/approvals', async (req, reply) => {
  const { jobKey, round, amount, agent } = req.body ?? ({} as never);
  if (!jobKey || round === undefined || !amount || !agent) return reply.code(400).send({ error: 'missing fields' });
  const [job, link] = await Promise.all([near.job(jobKey), near.link(agent)]);
  if (!job || job.round !== round || job.winner !== agent) return reply.code(409).send({ error: 'agent is not the on-chain winner of this round' });
  if (!link?.active || link.human !== job.human) return reply.code(403).send({ error: 'agent not linked to this human' });
  const cap = await near.cap(job.human);
  if (!cap || BigInt(amount) <= BigInt(cap)) return reply.code(400).send({ error: 'amount is within the cap: no approval needed' });

  const a: Approval = {
    id: `ap_${randomBytes(8).toString('hex')}`,
    mode: MODE,
    jobKey,
    round,
    amount,
    agent,
    human: job.human,
    status: 'PENDING',
    interval: 5,
    nextPollAt: Date.now(),
    startedAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TTL_MS,
  };
  if (MODE === 'world') await startWorld(a);
  else a.verificationUriComplete = `${PUBLIC_URL}/approvals/${a.id}/review`;
  approvals.set(a.id, a);
  return reply.code(201).send(pub(a));
});

app.get('/approvals', async () => [...approvals.values()].map(pub).reverse());

app.get<{ Params: { id: string } }>('/approvals/:id', async (req, reply) => {
  const a = approvals.get(req.params.id);
  return a ? pub(a) : reply.code(404).send({ error: 'unknown approval' });
});

// Manual mode only: a local review page (stand-in for World App).
app.get<{ Params: { id: string } }>('/approvals/:id/review', async (req, reply) => {
  const a = approvals.get(req.params.id);
  if (!a || a.mode !== 'manual') return reply.code(404).send('not found');
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Klero approval</title><body style="font:16px system-ui;max-width:520px;margin:40px auto;padding:0 16px">
<h2>Approve an over-cap payment?</h2>
<p style="background:#fff3cd;padding:8px">Manual mode: World ID is not configured, so this page stands in for World App.</p>
<p>Agent <b>${esc(a.agent)}</b> wants to pay <b>${Number(a.amount) / 1e6} FUSD</b><br>job ${esc(a.jobKey.slice(0, 16))}…, round ${a.round}</p>
<p>Status: <b>${a.status}</b>${a.approveTx ? ` · <a href="${nearblocksTx(a.approveTx)}">on-chain approval</a>` : ''}</p>
${a.status === 'PENDING' ? `<form method="post" action="/approvals/${a.id}/decide"><button name="d" value="approve">Approve</button> <button name="d" value="deny">Deny</button></form>` : ''}
</body>`);
});

app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) =>
  done(null, Object.fromEntries(new URLSearchParams(body as string))),
);
app.post<{ Params: { id: string }; Body: { d?: string } }>('/approvals/:id/decide', async (req, reply) => {
  const a = approvals.get(req.params.id);
  if (!a || a.mode !== 'manual' || a.status !== 'PENDING') return reply.code(409).send({ error: 'not pending' });
  if (req.body?.d === 'approve') await approveOnChain(a);
  else finish(a, 'DENIED', 'denied by the human');
  return reply.redirect(`/approvals/${a.id}/review`);
});

// worker: poll World, expire stale approvals
setInterval(async () => {
  for (const a of approvals.values()) {
    if (a.status !== 'PENDING') continue;
    if (Date.now() > a.expiresAt) {
      finish(a, 'EXPIRED', 'approval window closed');
      continue;
    }
    if (a.mode === 'world' && Date.now() >= a.nextPollAt) {
      a.nextPollAt = Date.now() + 60_000; // guard against overlapping polls
      await pollWorld(a).catch((e) => finish(a, 'FAILED', String(e)));
    }
  }
}, 1000);

await app.listen({ host: '0.0.0.0', port: Number(process.env.APPROVER_PORT ?? 4060) });
app.log.info(`approver mode: ${MODE}${MODE === 'manual' ? ' (set WORLD_CLIENT_ID / WORLD_CLIENT_SECRET for World ID)' : ''}`);
