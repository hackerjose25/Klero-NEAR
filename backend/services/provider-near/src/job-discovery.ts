export type DiscoveredJob = {
  contract: string;
  key: string;
  txHash: string;
  timestamp: string;
};

type Transaction = {
  transaction_hash: string;
  block_timestamp: string;
  actions?: { method?: string }[];
};

type TxnResponse = {
  data?: Transaction[];
  meta?: { next_page?: string };
};

const API = 'https://api-testnet.nearblocks.io/v3';

export function createJobDiscovery(contracts: string[]) {
  const jobs = new Map<string, DiscoveredJob>();
  const processed = new Set<string>();

  async function readReceipt(contract: string, tx: Transaction) {
    const url = `${API}/txns/${tx.transaction_hash}/receipts`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Receipt API returned ${response.status}`);
    }

    const result = await response.json();

    function inspect(node: any) {
      if (!node || typeof node !== 'object') return;

      if (Array.isArray(node)) {
        node.forEach(inspect);
        return;
      }

      if (Array.isArray(node.logs)) {
        for (const log of node.logs) {
          if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;

          try {
            const event = JSON.parse(log.slice('EVENT_JSON:'.length));
            if (event.standard !== 'klero' || event.event !== 'claim') continue;

            for (const item of event.data ?? []) {
              if (typeof item.job_key !== 'string') continue;

              const key = `${contract}:${item.job_key}`;
              jobs.set(key, {
                contract,
                key: item.job_key,
                txHash: tx.transaction_hash,
                timestamp: tx.block_timestamp,
              });
            }
          } catch {
            // Ignore malformed event logs.
          }
        }
      }

      if (node.outcome) inspect(node.outcome);
      if (node.receipts) inspect(node.receipts);
      if (node.data) inspect(node.data);
    }

    inspect(result);
  }

  async function scan(initial: boolean) {
    for (const contract of contracts) {
      let next: string | undefined;

      // Initial scan covers up to 10 pages. Later scans check the latest page.
      const maxPages = initial ? 10 : 1;

      for (let page = 0; page < maxPages; page++) {
        const url = new URL(`${API}/accounts/${contract}/txns`);
        url.searchParams.set('limit', '100');
        if (next) url.searchParams.set('next', next);

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Transaction API returned ${response.status} for ${contract}`);
        }

        const result = (await response.json()) as TxnResponse;
        const transactions = result.data ?? [];

        const claims = transactions.filter(
          (tx) =>
            tx.actions?.some((action) => action.method === 'claim') &&
            !processed.has(tx.transaction_hash),
        );

        await Promise.all(
          claims.map(async (tx) => {
            processed.add(tx.transaction_hash);
            try {
              await readReceipt(contract, tx);
            } catch (error) {
              processed.delete(tx.transaction_hash);
              console.warn(`Could not index claim ${tx.transaction_hash}:`, error);
            }
          }),
        );

        next = result.meta?.next_page;
        if (!next || transactions.length === 0) break;
      }
    }
  }

  async function safeScan(initial: boolean) {
    try {
      await scan(initial);
    } catch (error) {
      console.warn('Job discovery scan failed:', error);
    }
  }

  return {
    list: () => [...jobs.values()],
    start: () => {
      void safeScan(true);
      const timer = setInterval(() => void safeScan(false), 30_000);
      timer.unref();
    },
  };
}
