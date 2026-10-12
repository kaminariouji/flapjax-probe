#!/usr/bin/env node
// q20-reconcile.mjs — FlapJax claims-to-receipts reconciler (Q20 deliverable).
//
// Reads the public payout ledger published at https://flapjax.surge.sh/
// (the contributor board), the on-chain BSC transactions from the FlapJax
// treasury 0x7C34E9e21eE28A49Ff0b84B61774119E6633359f, and the public claim
// rows (BOARD slot=Bnn / quick-task claims, see q20-claims.json for sources).
// Flags wrong-task, wrong-recipient and duplicate credits; writes a CSV of
// findings where every row names the ledger row, the mismatch kind and the
// public sources a stranger can re-check.
//
// Zero dependencies. Node 18+ (global fetch). Read-only: no keys, no signing.
//
// Usage:
//   node q20-reconcile.mjs                         # fetch lander live, use shipped tx cache
//   node q20-reconcile.mjs --html lander.html      # use a saved lander snapshot
//   node q20-reconcile.mjs --rpc <url>             # override public RPC (default bsc-dataseed)
//   node q20-reconcile.mjs --txcache q20-tx-cache.json
//   node q20-reconcile.mjs --claims q20-claims.json --out q20-findings.csv
//
// Output: q20-findings.csv (empty-except-header = chain and ledger agree)
//         + a human summary on stdout.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const LANDER_URL = arg('--lander', 'https://flapjax.surge.sh/');
const HTML_FILE = arg('--html', null);
const RPC = arg('--rpc', 'https://bsc-dataseed.binance.org');
const TXCACHE = arg('--txcache', 'q20-tx-cache.json');
const CLAIMS_FILE = arg('--claims', 'q20-claims.json');
const OUT = arg('--out', 'q20-findings.csv');

const FJ = '0x90c8889f428f9ebb77bb8f15cad3a50a9ac680df';
const TREASURY = '0x7c34e9e21ee28a49ff0b84b61774119e6633359f';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(method, params, retry = 3) {
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 140));
      return j.result;
    } catch (e) {
      if (i === retry - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
}

// ---------- 1. lander: parse the public ledger (BOARD section) ----------

function parseLander(html) {
  const s = html.indexOf('BOARD:START');
  const e = html.indexOf('BOARD:END');
  if (s < 0 || e < 0) throw new Error('BOARD section not found in lander HTML');
  const board = html.slice(s, e);
  const unesc = t => t
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const strip = t => unesc(t.replace(/<[^>]+>/g, ' '));

  const rows = [];
  const chunks = board.split('<li class="fjx-c-row">').slice(1);
  for (const chunk of chunks) {
    const handle = strip((chunk.match(/<span class="fjx-c-handle">([\s\S]*?)<\/span>/) || [])[1] || '');
    const itemRe = /<li class="fjx-c-item">([\s\S]*?)<\/li>/g;
    let im;
    while ((im = itemRe.exec(chunk))) {
      const item = im[1];
      const workHtml = (item.match(/<span class="fjx-c-work">([\s\S]*?)<\/span>/) || [])[1] || '';
      const workLink = (workHtml.match(/href="([^"]+)"/) || [])[1] || '';
      const work = strip(workHtml);
      const amount = strip((item.match(/<span class="fjx-c-amt">([\s\S]*?)<\/span>/) || [])[1] || '');
      const meta = strip((item.match(/<span class="fjx-c-meta">([\s\S]*?)<\/span>/) || [])[1] || '');
      const tx = (item.match(/bscscan\.com\/tx\/(0x[0-9a-fA-F]{64})/) || [])[1] || '';
      const parts = meta.split('·').map(x => x.trim());
      rows.push({
        handle, work, work_link: workLink, amount_text: amount,
        date: parts[0] || '', task: parts[1] || '', tx,
      });
    }
  }
  return rows;
}

// ---------- 2. chain: fetch tx details (with cache) ----------

async function fetchTx(tx) {
  const [t, rc] = await Promise.all([
    rpc('eth_getTransactionByHash', [tx]),
    rpc('eth_getTransactionReceipt', [tx]),
  ]);
  if (!t || !rc) return { error: 'not found' };
  const fjTransfers = [];
  for (const l of rc.logs || []) {
    if (l.address.toLowerCase() === FJ && l.topics[0] === TRANSFER) {
      fjTransfers.push({
        from: '0x' + l.topics[1].slice(26),
        to: '0x' + l.topics[2].slice(26),
        value: (BigInt(l.data) / 10n ** 18n).toString(),
        valueWei: BigInt(l.data).toString(),
      });
    }
  }
  return {
    block: Number(BigInt(rc.blockNumber)), status: rc.status,
    from: (t.from || '').toLowerCase(), to: (t.to || '').toLowerCase(),
    value: t.value, gasUsed: rc.gasUsed, fjTransfers,
  };
}

// ---------- 3. checks ----------

const parseAmt = t => { const m = t.replace(/,/g, '').match(/^(\d+)/); return m ? m[1] : null; };

function reconcile(rows, txData, claims) {
  const findings = [];
  const add = (kind, rowRef, detail, sources, resolution = '') =>
    findings.push({ kind, rowRef, detail, sources: sources.filter(Boolean).join(' | '), resolution });

  rows.forEach((r, i) => {
    const n = i + 1;
    const ref = `row ${n} (@${r.handle.replace(/^@/, '')})`;
    const d = txData[r.tx];
    const txSrc = `https://bscscan.com/tx/${r.tx}`;
    const ledgerSrc = 'https://flapjax.surge.sh/ (contributor board row ' + n + ')';

    if (!d || d.error) { add('tx_missing', ref, 'tx not retrievable from public RPC: ' + r.tx, [ledgerSrc, txSrc]); return; }
    if (d.status !== '0x1') add('tx_status', ref, `receipt status ${d.status} (not success)`, [ledgerSrc, txSrc]);
    if (d.from !== TREASURY) add('tx_sender', ref, `tx sender ${d.from} != treasury`, [ledgerSrc, txSrc]);
    if (!d.fjTransfers || d.fjTransfers.length !== 1) {
      add('transfer_count', ref, `expected exactly 1 FLAPJAX Transfer log, got ${(d.fjTransfers || []).length}`, [ledgerSrc, txSrc]);
    } else {
      const t = d.fjTransfers[0];
      if (t.from !== TREASURY) add('transfer_sender', ref, `FLAPJAX Transfer from ${t.from} != treasury`, [ledgerSrc, txSrc]);
      const amt = parseAmt(r.amount_text);
      if (amt !== t.value) add('amount_mismatch', ref, `ledger says ${r.amount_text}, chain shows ${t.value} FJ`, [ledgerSrc, txSrc]);
      // board-slot rows: recipient + advertised amount vs the claim registry
      const slot = (r.task.match(/B\d+/) || [])[0];
      if (slot && claims.slots && claims.slots[slot]) {
        const spec = claims.slots[slot];
        const claimers = (claims.board_claims || []).filter(c => c.slot === slot && c.wallet);
        if (claimers.length && !claimers.some(c => c.wallet.toLowerCase() === t.to)) {
          add('wrong_recipient', ref, `slot ${slot} paid to ${t.to}; declared claim wallet(s): ` +
            claimers.map(c => `${c.handle}=${c.wallet}`).join(', '),
            [ledgerSrc, txSrc, ...claimers.map(c => c.url)], spec.resolution);
        }
        if (spec.amount && Number(t.value) !== spec.amount) {
          add('wrong_amount_vs_slot', ref, `slot ${slot} advertised ${spec.amount} FJ, paid ${t.value} FJ`,
            [ledgerSrc, txSrc, spec.source], spec.resolution);
        }
      }
    }
  });

  // duplicate tx across rows
  const byTx = {};
  rows.forEach((r, i) => (byTx[r.tx] = byTx[r.tx] || []).push(i + 1));
  for (const [tx, idxs] of Object.entries(byTx)) {
    if (idxs.length > 1) add('duplicate_tx', `rows ${idxs.join(',')}`, `same tx hash listed in ${idxs.length} ledger rows`,
      ['https://flapjax.surge.sh/ (contributor board)', `https://bscscan.com/tx/${tx}`]);
  }

  // same handle + same task label paid twice (different txs)
  const byHT = {};
  rows.forEach((r, i) => { const k = r.handle + '|' + r.task; (byHT[k] = byHT[k] || []).push(i + 1); });
  for (const [k, idxs] of Object.entries(byHT)) {
    if (idxs.length > 1) {
      const [handle, task] = k.split('|');
      const note = (claims.identity_notes || []).find(n => n.kind === 'same_handle_task' && n.match === handle + '|' + task);
      add('duplicate_credit_candidate', `rows ${idxs.join(',')}`,
        `@${handle.replace(/^@/, '')} credited ${idxs.length}x under task label "${task}"`,
        ['https://flapjax.surge.sh/ (contributor board)', ...(note ? note.sources : [])],
        note ? note.resolution : 'needs review: same handle + task label paid more than once');
    }
  }

  // one wallet across handles / one handle across wallets
  const walletHandles = {}, handleWallets = {};
  rows.forEach((r, i) => {
    const d = txData[r.tx];
    if (!d || !d.fjTransfers || !d.fjTransfers[0]) return;
    const w = d.fjTransfers[0].to;
    (walletHandles[w] = walletHandles[w] || { handles: new Set(), rows: [] });
    walletHandles[w].handles.add(r.handle); walletHandles[w].rows.push(i + 1);
    (handleWallets[r.handle] = handleWallets[r.handle] || { wallets: new Set(), rows: [] });
    handleWallets[r.handle].wallets.add(w); handleWallets[r.handle].rows.push(i + 1);
  });
  for (const [w, v] of Object.entries(walletHandles)) {
    if (v.handles.size > 1) {
      const note = (claims.identity_notes || []).find(n => n.kind === 'wallet_across_handles' && n.wallet.toLowerCase() === w);
      add('duplicate_credit_candidate', `rows ${v.rows.join(',')}`,
        `one EOA ${w} received credits under ${v.handles.size} handles: ${[...v.handles].join(', ')}`,
        ['https://flapjax.surge.sh/ (contributor board)', ...(note ? note.sources : [])],
        note ? note.resolution : 'needs review: one wallet credited under multiple handles');
    }
  }
  for (const [h, v] of Object.entries(handleWallets)) {
    if (v.wallets.size > 1) {
      const note = (claims.identity_notes || []).find(n => n.kind === 'handle_across_wallets' && n.handle === h);
      add('wrong_recipient_candidate', `rows ${v.rows.join(',')}`,
        `@${h.replace(/^@/, '')} credited to ${v.wallets.size} different wallets: ${[...v.wallets].join(', ')}`,
        ['https://flapjax.surge.sh/ (contributor board)', ...(note ? note.sources : [])],
        note ? note.resolution : 'needs review: one handle credited to multiple wallets');
    }
  }
  return findings;
}

// ---------- main ----------

const html = HTML_FILE
  ? readFileSync(HTML_FILE, 'utf8')
  : await (await fetch(LANDER_URL)).text();
const rows = parseLander(html);
console.log(`ledger rows parsed: ${rows.length} (${new Set(rows.map(r => r.tx)).size} unique txs)`);

const claims = existsSync(CLAIMS_FILE) ? JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')) : {};

let cache = {};
if (existsSync(TXCACHE)) cache = JSON.parse(readFileSync(TXCACHE, 'utf8'));
const txs = [...new Set(rows.map(r => r.tx))];
let fetched = 0;
for (const tx of txs) {
  if (cache[tx] && !cache[tx].error) continue;
  try {
    cache[tx] = await fetchTx(tx);
    fetched++;
    if (fetched % 10 === 0) console.log(`  fetched ${fetched} txs from RPC...`);
  } catch (e) {
    cache[tx] = { error: String(e.message).slice(0, 160) };
  }
  await sleep(200);
}
if (fetched) writeFileSync(TXCACHE, JSON.stringify(cache, null, 1));
console.log(`tx details: ${txs.filter(t => cache[t] && !cache[t].error).length}/${txs.length} resolved (${fetched} fetched now, rest from cache)`);

const findings = reconcile(rows, cache, claims);

const esc = s => '"' + String(s).replace(/"/g, '""') + '"';
const header = ['kind', 'row_ref', 'detail', 'resolution', 'sources'];
const csv = [header.join(',')].concat(
  findings.map(f => [f.kind, f.rowRef, f.detail, f.resolution, f.sources].map(esc).join(','))
).join('\n') + '\n';
writeFileSync(OUT, csv);

console.log(`\nfindings: ${findings.length} → ${OUT}`);
for (const f of findings) console.log(`  [${f.kind}] ${f.rowRef}: ${f.detail}`);
if (!findings.length) console.log('  (empty: the chain and the public ledger agree on every row)');
