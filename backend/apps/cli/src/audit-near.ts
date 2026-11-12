// Independent audit of the Klero contract on NEAR.
// It lists the contract's transactions (and the escrows sent through the token) from NearBlocks, reads every
// receipt's logs from a public NEAR RPC, replays the NEP-297 events, and checks each job. No Klero server or key is
// involved; NearBlocks is only used to find tx hashes, and every fact is read back from RPC.

type Ev = { event: string; data: any; tx: string; ts: bigint; seq: number };
type FtMove = { from: string; to: string; amount: string; memo?: string; tx: string };
export type Check = { job: string; check: string; ok: boolean; detail: string };

export type AuditNearOpts = { contract: string; token: string; rpc: string; archival: string; nearblocks: string; job?: string; log?: (s: string) => void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit, tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await sleep(Math.min(1000 * 2 ** i, 20_000));
    }
  }
}

async function listTxns(nb: string, account: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | undefined;
  do {
    const u = `${nb}/v3/accounts/${account}/txns?limit=100${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    const j = await getJson(u);
    out.push(...(j.data ?? []));
    next = j.meta?.next_page ?? undefined;
  } while (next);
  return out;
}

// Several endpoints may be given (comma-separated); a rate-limited or failing one hands over to the next.
async function rpc(urls: string, method: string, params: unknown): Promise<any> {
  const list = urls.split(',').map((u) => u.trim()).filter(Boolean);
  let last: unknown;
  for (let round = 0; round < 3; round++) {
    for (const url of list) {
      try {
        return await rpcOne(url, method, params);
      } catch (e) {
        if (String(e).includes('UNKNOWN_TRANSACTION') && url !== list[list.length - 1]) { last = e; continue; }
        last = e;
      }
    }
    await sleep(5000 * (round + 1));
  }
  throw last;
}

async function rpcOne(url: string, method: string, params: unknown): Promise<any> {
  const j = await getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'audit', method, params }),
  });
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}

async function view(url: string, contract: string, method: string, args: object): Promise<any> {
  const r = await rpc(url, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}

function parseEvent(line: string): any | null {
  if (!line.startsWith('EVENT_JSON:')) return null;
  try {
    return JSON.parse(line.slice('EVENT_JSON:'.length));
  } catch {
    return null;
  }
}

export async function auditNear(o: AuditNearOpts) {
  const log = o.log ?? (() => {});
  const [ctx, tkx] = await Promise.all([listTxns(o.nearblocks, o.contract), listTxns(o.nearblocks, o.token)]);
  const escrows = tkx.filter((t) => t.actions?.some((a: any) => a.method === 'ft_transfer_call'));
  const txs = [...ctx, ...escrows];
  const uniq = new Map<string, any>();
  for (const t of txs) uniq.set(t.transaction_hash, t);
  log(`${uniq.size} transactions to read (${ctx.length} to the contract, ${escrows.length} escrows via the token)`);

  const events: Ev[] = [];
  const moves: FtMove[] = [];
  let seq = 0;
  const sorted = [...uniq.values()].sort((a, b) => (BigInt(a.block_timestamp) < BigInt(b.block_timestamp) ? -1 : 1));
  for (const t of sorted) {
    await sleep(300); // stay under public RPC rate limits
    const st = await rpc(o.archival, 'EXPERIMENTAL_tx_status', {
      tx_hash: t.transaction_hash,
      sender_account_id: t.signer_account_id,
      wait_until: 'NONE',
    });
    const ts = BigInt(t.block_timestamp);
    for (const ro of st.receipts_outcome ?? []) {
      const exec = ro.outcome.executor_id;
      for (const line of ro.outcome.logs ?? []) {
        const ev = parseEvent(line);
        if (!ev) continue;
        if (exec === o.contract && ev.standard === 'klero') {
          for (const d of ev.data ?? []) events.push({ event: ev.event, data: d, tx: t.transaction_hash, ts, seq: seq++ });
        } else if (exec === o.token && ev.standard === 'nep141' && ev.event === 'ft_transfer') {
          for (const d of ev.data ?? [])
            moves.push({ from: d.old_owner_id, to: d.new_owner_id, amount: String(d.amount), memo: d.memo, tx: t.transaction_hash });
        }
      }
    }
  }
  events.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
  log(`${events.length} Klero events, ${moves.length} token transfers`);

  // Replay.
  const humanOf = new Map<string, string>(); // agent -> human
  const capOf = new Map<string, bigint | null>(); // human -> cap
  const approvals = new Map<string, bigint>(); // intent_id -> max
  type Round = { winners: string[]; provider?: string; abandoned?: boolean };
  type Intent = { id: string; round: number; payer: string; provider: string; amount: bigint; settled?: Ev; voided?: Ev; capOk: boolean; capDetail: string };
  const jobs = new Map<string, { human?: string; rounds: Map<number, Round>; intents: Intent[] }>();
  const job = (k: string) => {
    let j = jobs.get(k);
    if (!j) jobs.set(k, (j = { rounds: new Map(), intents: [] }));
    return j;
  };
  const round = (k: string, r: number) => {
    const j = job(k);
    let x = j.rounds.get(r);
    if (!x) j.rounds.set(r, (x = { winners: [] }));
    return x;
  };
  const intentById = new Map<string, Intent>();
  const splitId = (id: string) => {
    const i = id.lastIndexOf(':');
    return { jobKey: id.slice(0, i), round: Number(id.slice(i + 1)) };
  };

  for (const e of events) {
    const d = e.data;
    switch (e.event) {
      case 'link':
        humanOf.set(d.agent, d.human);
        break;
      case 'cap':
        capOf.set(d.human, d.cap == null ? null : BigInt(d.cap));
        break;
      case 'approve':
        approvals.set(d.intent_id, BigInt(d.max_amount));
        break;
      case 'claim': {
        const j = job(d.job_key);
        j.human ??= humanOf.get(d.agent);
        if (d.won) {
          const r = round(d.job_key, d.round);
          r.winners.push(d.agent);
          r.provider = d.provider;
        }
        break;
      }
      case 'abandon':
        round(d.job_key, d.round).abandoned = true;
        break;
      case 'intent': {
        const { jobKey, round: r } = splitId(d.intent_id);
        const j = job(jobKey);
        const amount = BigInt(d.amount);
        const human = j.human ?? humanOf.get(d.payer);
        const cap = human ? capOf.get(human) : undefined;
        let capOk = true;
        let capDetail = cap == null ? 'no cap set' : `${amount} <= cap ${cap}`;
        if (cap != null && amount > cap) {
          const appr = approvals.get(d.intent_id);
          capOk = appr != null && amount <= appr;
          capDetail = capOk ? `over cap ${cap}, approved up to ${appr}` : `over cap ${cap} with no matching approval`;
          approvals.delete(d.intent_id);
        }
        const it: Intent = { id: d.intent_id, round: r, payer: d.payer, provider: d.provider, amount, capOk, capDetail };
        j.intents.push(it);
        intentById.set(it.id, it);
        break;
      }
      case 'settled': {
        const it = intentById.get(d.intent_id);
        if (it) it.settled = e;
        break;
      }
      case 'void': {
        const it = intentById.get(d.intent_id);
        if (it) it.voided = e;
        break;
      }
    }
  }

  // Check.
  const checks: Check[] = [];
  const add = (job: string, check: string, ok: boolean, detail: string) => checks.push({ job, check, ok, detail });
  const fromContract = (to: string, amount: bigint, memo: string, tx: string) =>
    moves.find((m) => m.tx === tx && m.from === o.contract && m.to === to && BigInt(m.amount) === amount && m.memo === memo);

  for (const [k, j] of jobs) {
    if (o.job && !k.startsWith(o.job)) continue;
    for (const [r, x] of [...j.rounds].sort((a, b) => a[0] - b[0])) {
      add(k, `one-winner r${r}`, x.winners.length <= 1, `${x.winners.length} winning claim(s)${x.winners[0] ? `: ${x.winners[0]}` : ''}`);
      if (x.abandoned) {
        const paid = j.intents.some((i) => i.round === r);
        add(k, `abandoned-free r${r}`, !paid, paid ? 'an intent exists for an abandoned round' : 'abandoned, no escrow, no money moved');
      }
      // Completeness: the replay must know every intent the contract knows (catches a missing or partial index).
      const onChain = await view(o.rpc, o.contract, 'get_intent', { intent_id: `${k}:${r}` });
      const replayed = j.intents.some((i) => i.round === r);
      add(k, `replay-complete r${r}`, !!onChain === replayed, onChain ? (replayed ? 'intent on-chain and in replay' : 'intent on-chain but MISSING from replay') : replayed ? 'intent in replay but not on-chain' : 'no intent on-chain or in replay');
    }
    const settled = j.intents.filter((i) => i.settled);
    add(k, 'paid-at-most-once', settled.length <= 1, `${settled.length} settled payment(s)`);
    for (const it of j.intents) {
      const r = j.rounds.get(it.round);
      const okW = !!r && r.winners.length === 1 && r.winners[0] === it.payer && r.provider === it.provider;
      add(k, `payer-is-winner r${it.round}`, okW, `payer ${it.payer} → ${it.provider}`);
      add(k, `cap-respected r${it.round}`, it.capOk, it.capDetail);
      add(k, `one-ending r${it.round}`, !(it.settled && it.voided), it.settled ? 'PAID' : it.voided ? 'VOID' : 'open');
      if (it.settled) {
        const m = fromContract(it.provider, it.amount, `klero:${it.id}`, it.settled.tx);
        add(k, `settle-on-ledger r${it.round}`, !!m, m ? `${it.amount} → ${it.provider} (tx ${it.settled.tx.slice(0, 10)}…)` : 'no matching token transfer');
      }
      if (it.voided) {
        const m = fromContract(it.payer, it.amount, `klero-void:${it.id}`, it.voided.tx);
        add(k, `refund-on-ledger r${it.round}`, !!m, m ? `${it.amount} refunded → ${it.payer} (tx ${it.voided.tx.slice(0, 10)}…)` : 'no matching refund');
      }
      const state: string | null = await view(o.rpc, o.contract, 'get_intent_state', { intent_id: it.id });
      const expect = it.settled ? ['PAID'] : it.voided ? ['VOID'] : ['PENDING', 'EXPIRED', 'SETTLING', 'VOIDING'];
      add(k, `state-matches r${it.round}`, !!state && expect.includes(state), `contract says ${state}, replay says ${expect.join('/')}`);
    }
  }
  const audited = [...jobs.keys()].filter((k) => !o.job || k.startsWith(o.job)).length;
  return { jobs: audited, events: events.length, checks, ok: checks.every((c) => c.ok) };
}
