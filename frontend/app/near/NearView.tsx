'use client';

import { useCallback, useEffect, useState } from 'react';

// Public testnet facts (backend/deployments/near-testnet.json). Nothing here is trusted: every state is read live from the chain.
const RPC = 'https://test.rpc.fastnear.com';
const NB = 'https://testnet.nearblocks.io';
const OPERATOR = 'klero-mw8x6bn1.testnet';
const V2 = 'klero-v2.klero-mw8x6bn1.testnet';
const V1 = 'klero.klero-mw8x6bn1.testnet';
const TOKEN = 'fusd.klero-mw8x6bn1.testnet';
const HUMAN = 'human.klero-mw8x6bn1.testnet';
const AGENTS = ['a', 'b', 'c'].map((x) => `${x}.${HUMAN}`);
const DECIMALS = 6;

type Demo = { contract: string; key: string; label: string };
const DEMOS: Demo[] = [
  { contract: V2, key: '09fd9a665884f511b71333aee6fff5a870bc2b2453a3e7790b5dc713d47490a8', label: 'Over the cap: the human denied (round abandoned, nothing moved), then approved → 2 FUSD paid once' },
  { contract: V2, key: 'b1a8f974bcd5a49fb04f963d0bb53506fa589406a1503e202d892d9dd7b71d36', label: 'Over the cap: round 0 abandoned, round 1 approved → paid once' },
  { contract: V2, key: '321dfc3468a959fa9b097fb8d54aa16dece96f791ac44ad82ef28d92dcca264a', label: 'Over the cap with no approval: the contract refused the escrow, the agent kept its money' },
  { contract: V1, key: '0d3cd8b74ebf0ad8b3589b14d0b321c95d358de11aab8868bcc9d7b4a3d6f6d3', label: 'Provider crashed after escrow: round 0 VOID and refunded, round 1 paid once' },
  { contract: V1, key: '0ef4f6989eb0adda177d546128625ba5f8dac7a12919049dbe6d4dee4b9a88d9', label: 'Never settled: deadline passed → VOID, refunded' },
  { contract: V1, key: '1b3b6a5b0f7fec8a7b6bfdfc04ab8cc8ab79047763f3ea9b8b5dcc14f8a1764d', label: 'Three agents, one winner, delivered → paid once' },
  { contract: V1, key: '11ec01e9db7292ae89b66ab4d09776ea9c515a008c62d10a0ec400bc1e68e02d', label: 'Smoke test: three claims, one escrow, settled → paid once' },
];

type Job = { human: string; round: number; winner: string | null; provider: string | null; status: string; intent_id: string | null };
type Intent = { job_key: string; round: number; payer: string; provider: string; amount: string; created_ns: number; deadline_ns: number; status: string };
type Row = { round: number; intent: Intent | null; state: string | null };
type Loaded = { job: Job | null; rows: Row[]; cap: string | null };

async function view<T>(contract: string, method: string, args: object): Promise<T> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'near-page',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

async function loadJob(contract: string, key: string): Promise<Loaded> {
  const job = await view<Job | null>(contract, 'get_job', { job_key: key });
  if (!job) return { job: null, rows: [], cap: null };
  const rows = await Promise.all(
    Array.from({ length: job.round + 1 }, async (_, round) => {
      const id = `${key}:${round}`;
      const [intent, state] = await Promise.all([
        view<Intent | null>(contract, 'get_intent', { intent_id: id }),
        view<string | null>(contract, 'get_intent_state', { intent_id: id }),
      ]);
      return { round, intent, state };
    }),
  );
  const cap = contract === V2 ? await view<string | null>(contract, 'get_cap', { human: job.human }).catch(() => null) : null;
  return { job, rows, cap };
}

const fusd = (base: string) => (Number(base) / 10 ** DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (acct: string) => acct.replace(`.${OPERATOR}`, '');
const acctLink = (a: string) => `${NB}/address/${a}`;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StateBadge({ state }: { state: string | null }) {
  const s = state ?? 'NO ESCROW';
  const cls = s === 'PAID' ? 'ok' : s === 'VOID' ? 'void' : s === 'EXPIRED' ? 'warn' : s === 'NO ESCROW' ? 'none' : 'info';
  return <span className={`nr-badge nr-${cls}`}>{s}</span>;
}

function Clock({ intent, state }: { intent: Intent; state: string | null }) {
  const live = state === 'PENDING';
  const now = useNow(live);
  if (!live) return null;
  const left = Math.max(0, Math.round(intent.deadline_ns / 1e6 - now) / 1000);
  return <span className="nr-clock">settle window closes in {left.toFixed(1)} s, then anyone may void</span>;
}

function JobCard({ contract, jobKey, label }: { contract: string; jobKey: string; label?: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    loadJob(contract, jobKey).then(setData, (e) => setErr(String(e)));
  }, [contract, jobKey]);
  useEffect(load, [load]);

  const paid = data?.rows.filter((r) => r.state === 'PAID').length ?? 0;
  return (
    <article className="nr-card">
      <header className="nr-card-head">
        <div>
          {label && <p className="nr-label">{label}</p>}
          <p className="mono">
            job {jobKey.slice(0, 16)}… · <a href={acctLink(contract)} target="_blank" rel="noreferrer">{contract === V2 ? 'contract v2' : 'contract v1'}</a>
          </p>
        </div>
        <div className="nr-count">
          <span className="num">{data ? paid : '–'}</span>
          <span className="nr-micro">payments</span>
        </div>
      </header>
      {err && <p className="nr-err">Could not read the contract: {err} <button onClick={load}>retry</button></p>}
      {!data && !err && <p className="nr-micro">reading the contract…</p>}
      {data && !data.job && <p className="nr-micro">No such job on this contract.</p>}
      {data?.job && (
        <>
          <table className="nr-table">
            <thead>
              <tr><th>Round</th><th>Payment</th><th>Payer → provider</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.round}>
                  <td className="num">{r.round}</td>
                  <td><StateBadge state={r.state} />{r.intent && <Clock intent={r.intent} state={r.state} />}</td>
                  <td className="mono">
                    {r.intent ? (
                      <>
                        <a href={acctLink(r.intent.payer)} target="_blank" rel="noreferrer">{short(r.intent.payer)}</a> →{' '}
                        <a href={acctLink(r.intent.provider)} target="_blank" rel="noreferrer">{short(r.intent.provider)}</a>
                      </>
                    ) : r.round === data.job!.round ? (
                      data.job!.winner ? `winner ${short(data.job!.winner)}, awaiting escrow` : 'open'
                    ) : (
                      'abandoned or refused: no money moved'
                    )}
                  </td>
                  <td className="num">{r.intent ? `${fusd(r.intent.amount)} FUSD` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="nr-micro">
            job status <b>{data.job.status}</b> · current round {data.job.round}
            {data.cap && <> · human cap {fusd(data.cap)} FUSD per payment</>}
          </p>
        </>
      )}
    </article>
  );
}

export default function NearView() {
  const [q, setQ] = useState('');
  const [lookup, setLookup] = useState<{ contract: string; key: string } | null>(null);
  const [contract, setContract] = useState(V2);

  return (
    <div className="sp nr">
      <main className="nr-wrap">
        <p className="nr-kicker">NEAR testnet · live</p>
        <h1 className="nr-h1">Agents fork. Money doesn’t.</h1>
        <p className="nr-lead">
          Three AI agents of one human race for the same job. The Klero contract on NEAR picks one winner, holds the payment in escrow, and
          ends it exactly one way: <b>PAID</b> once by the provider before the deadline, or <b>VOID</b> and refunded after it. Every row
          below is read live from the contract in your browser, not from our server.
        </p>

        <section className="nr-facts">
          <a href={acctLink(V2)} target="_blank" rel="noreferrer"><span className="nr-micro">Contract</span><span className="mono">{V2}</span></a>
          <a href={acctLink(TOKEN)} target="_blank" rel="noreferrer"><span className="nr-micro">Token (NEP-141, 6 dp)</span><span className="mono">{TOKEN}</span></a>
          <a href={acctLink(HUMAN)} target="_blank" rel="noreferrer"><span className="nr-micro">Human</span><span className="mono">{HUMAN}</span></a>
          <div>
            <span className="nr-micro">Agents (sub-accounts, claim-only keys)</span>
            {AGENTS.map((a) => (
              <a key={a} className="mono" href={acctLink(a)} target="_blank" rel="noreferrer">{a}</a>
            ))}
          </div>
        </section>

        <section>
          <h2 className="nr-h2">Look up any job</h2>
          <form
            className="nr-form"
            onSubmit={(e) => {
              e.preventDefault();
              const key = q.trim();
              if (key) setLookup({ contract, key });
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="job key (64 hex chars)" aria-label="job key" />
            <select value={contract} onChange={(e) => setContract(e.target.value)} aria-label="contract">
              <option value={V2}>v2</option>
              <option value={V1}>v1</option>
            </select>
            <button type="submit">Read</button>
          </form>
          {lookup && <JobCard key={`${lookup.contract}:${lookup.key}`} contract={lookup.contract} jobKey={lookup.key} />}
        </section>

        <section>
          <h2 className="nr-h2">Jobs from the recorded proof runs</h2>
          <div className="nr-grid">
            {DEMOS.map((d) => (
              <JobCard key={d.key} contract={d.contract} jobKey={d.key} label={d.label} />
            ))}
          </div>
        </section>

        <section className="nr-verify">
          <h2 className="nr-h2">Don’t trust this page either</h2>
          <p>
            Run <code>pnpm audit:near</code> in <code>backend/</code>. It replays every job from NearBlocks and an archival RPC and checks
            one winner per round, paid at most once, the cap, and every settlement and refund against the token’s transfers. Source and
            proof: <a href="https://github.com/hackerjose25/Klero-NEAR" target="_blank" rel="noreferrer">github.com/hackerjose25/Klero-NEAR</a>.
          </p>
          <p className="nr-micro" style={{ marginTop: 12 }}>
            Klero was first built on Hedera; that version is kept at <a href="/hedera">/hedera</a>. Only the NEAR work is the hackathon entry.
          </p>
        </section>
      </main>
    </div>
  );
}
