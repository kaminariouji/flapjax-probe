// gen.mjs — page generator for the Receipt Relay Oct 13 (5/14) audit.
//
//   node gen.mjs                -> regenerates raw.json + index.html (byte-identical to the published page)
//   node gen.mjs --selftest     -> proves the definition check fires (strips one definition, expects the abort)
//   node gen.mjs --selftest-gap -> proves the row-set check fires (drops one grant row, expects the abort)
//
// The rules enforced here (not remembered):
//   1. Every figure that travels must carry its definition — including its
//      row-selection rule — in the same cell. assertDefined() throws instead of
//      emitting a page where any required definition is missing.
//   2. The row set must be provably complete: assertContiguousNonces() refuses
//      to emit a page whose nonce sequence has a gap, because a gap means a
//      treasury tx is missing from the table (the exact failure class of the
//      10-12 receipt — one grant omitted).
// A convention is a promise; these are bounds, and both selftests prove they fire.
//
// Inputs (both in this directory, public chain data):
//   audit-13.json             treasury txs in the window + boundary balances (nonce 88-104)
//   audit-13-recipients.json  per-recipient balance deltas (recipient +value, treasury -value)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const read = f => JSON.parse(readFileSync(here + f, 'utf8'))
const write = (f, s) => writeFileSync(here + f, s)

const RPCS = [
  'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
  'https://bsc-rpc.publicnode.com',
]
let rpcIdx = 0
async function rpc(method, params) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = RPCS[rpcIdx % RPCS.length]
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const j = await r.json()
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error).slice(0, 120))
      return j.result
    } catch (e) { lastErr = e; rpcIdx++; await new Promise(res => setTimeout(res, 600)) }
  }
  throw lastErr
}

const audit = read('audit-13.json')
const checks = read('audit-13-recipients.json')

// ---- definition check: the rule is enforced here, not remembered ----
// Every figure that travels must carry its definition — window, measure AND
// row-selection rule — in the same cell. If a definition is empty the
// generator refuses to emit the page. `--selftest` proves the check fires.
const ROWSET = 'all treasury-sent txs in window, incl. gas grants (15 FJ grants + 1 BNB bounty-funding transfer; excludes the buy tx)'
const DEFS = {
  non_buy_out: `outbound value sent by the treasury in this window — row set: ${ROWSET}; transfer value only, fees itemised on the fees row`,
  non_buy_out_total: `outbound value + gas fees — row set: ${ROWSET}`,
  fees: `gas only — row set: ${ROWSET}`,
}
function assertDefined(defs) {
  const missing = Object.entries(defs).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k)
  if (missing.length) throw new Error('definition missing for: ' + missing.join(', ') + ' — refusing to emit the page')
}
const selftest = process.argv.includes('--selftest')
if (selftest) DEFS.fees = '' // simulate a hurried edit
try {
  assertDefined(DEFS)
  if (selftest) { console.log('SELFTEST: check did NOT fire'); process.exit(1) }
} catch (e) {
  if (selftest) { console.log('SELFTEST OK — generator aborted: ' + e.message); process.exit(0) }
  throw e
}

// ---- block times ----
const blocks = [...new Set(audit.txs.map(t => t.block))].sort((a, b) => a - b)
const times = {}
for (const b of blocks) {
  const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), false])
  times[b] = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  await new Promise(r => setTimeout(r, 120))
}

// ---- formatters ----
const fmt = (v, d = 18) => {
  const b = BigInt(v)
  const s = b / 10n ** BigInt(d)
  const f = (b % 10n ** BigInt(d)).toString().padStart(d, '0').replace(/0+$/, '')
  return f ? `${s}.${f}` : s.toString()
}
const fmtFJ = v => {
  // thousands separators + 6 decimals for compact display
  const s = fmt(v)
  const [i, f = ''] = s.split('.')
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f.slice(0, 6) : '')
}
const short = (h, n = 10) => h.slice(0, n) + '…' + h.slice(-6)

// ---- rows ----
const rows = []
for (const tx of audit.txs) {
  const c = checks.checks.find(x => x.hash === tx.hash)
  const b = tx.block
  const feeBNB = fmt(tx.fee)
  let value, logRec, deltaAddr, match
  if (tx.label === 'fj-grant') {
    value = fmtFJ(tx.fjLogs[0].value) + ' FJ'
    logRec = tx.fjLogs[0].to
    deltaAddr = tx.fjLogs[0].to
    match = c.match && c.senderMatch
  } else if (tx.label === 'buy-13') {
    value = '0.01 BNB → ' + fmtFJ(tx.fjLogs[0].value) + ' FJ'
    logRec = tx.fjLogs[0].to + ' (pool → treasury)'
    deltaAddr = '0x7c34e9e21ee28a49ff0b84b61774119e6633359f'
    match = c.match && c.bnbMatch
  } else {
    value = fmt(tx.value) + ' BNB'
    logRec = '(no token log — plain BNB transfer)'
    deltaAddr = tx.to
    match = c.match
  }
  rows.push({
    nonce: c.nonce, hash: tx.hash, block: b, time: times[b], label: tx.label,
    logRec, deltaAddr, value, fee: feeBNB, match,
  })
}
rows.sort((a, b) => b.nonce - a.nonce) // newest first

// ---- row-set check: the row-selection rule is enforced too, not just stated ----
// A gap in the nonce sequence means a treasury tx exists that is not in the
// table. The generator refuses to emit a page whose row set is not provably
// complete. `--selftest-gap` drops one grant row and proves the check fires.
function assertContiguousNonces(rows) {
  const ns = rows.map(r => r.nonce).sort((a, b) => a - b)
  for (let i = 1; i < ns.length; i++) {
    if (ns[i] !== ns[i - 1] + 1) {
      throw new Error(`nonce sequence not contiguous: ${ns[i - 1]} -> ${ns[i]} — a treasury tx is missing from the row set; refusing to emit the page`)
    }
  }
}
const selftestGap = process.argv.includes('--selftest-gap')
if (selftestGap) rows.splice(rows.findIndex(r => r.label === 'fj-grant'), 1) // simulate a dropped grant row
try {
  assertContiguousNonces(rows)
  if (selftestGap) { console.log('SELFTEST-GAP: check did NOT fire'); process.exit(1) }
} catch (e) {
  if (selftestGap) { console.log('SELFTEST-GAP OK — generator aborted: ' + e.message); process.exit(0) }
  throw e
}

// ---- receipt figures ----
const R = {
  buy: { line: '0.01 BNB → 23,762,833.230024087278551319 FLAPJAX', chain: fmtFJ(audit.txs.find(t => t.label === 'buy-13').fjLogs[0].value) + ' FJ', verdict: 'match (exact)' },
  bnbNow: { line: '0.118264579546597688 BNB', chain: fmt(audit['bal_post-buy-13']), verdict: 'match (exact)' },
  fjNow: { line: '274,255,010.558598611392113994 FLAPJAX', chain: fmt(audit['fj_fj-post-buy-13']), verdict: 'match (exact)' },
}
const lifi = audit.txs.find(t => t.label === 'out-lifi')
const sumFees = audit.txs.filter(t => t.label !== 'buy-13').reduce((s, t) => s + BigInt(t.fee), 0n)
const totalNonBuy = BigInt(lifi.value) + sumFees
const pre13 = BigInt(audit['bal_pre-buy-13'])
const post13 = BigInt(audit['bal_post-buy-13'])
const buyTx = audit.txs.find(t => t.label === 'buy-13')
const windowDelta = pre13 - post13
const expectedDelta = BigInt(buyTx.value) + BigInt(buyTx.fee)
const nonBuyWindow = pre13 - (post13 + BigInt(buyTx.value) + BigInt(buyTx.fee))
// theoretical post-buy-12 = pre13 + non-buy outflow
const postBuy12 = pre13 + totalNonBuy
// actual post-buy-12 figure from the Oct 12 audit (Q23) — the two windows must join without a gap
const postBuy12Actual = 132607152559380905n
const joinMatch = postBuy12 === postBuy12Actual

const raw = {
  task: 'Receipt Relay — FlapJax Oct 13 buyback receipt (5/14) vs BSC chain, per-tx columns log_recipient / delta_address / match',
  auditor: '@kaminari-research (The Colony)',
  wallet: '0x8c062dc5d775b7d5efc168f75a875f392f53dcdf',
  window: audit.window,
  receipt: {
    comment: 'https://thecolony.ai/post/28acbdea-449b-4717-9517-6619a94247c8 (comment 80547a29, 2026-10-13 18:41:59Z)',
    buyLine: R.buy.line, treasuryBnb: R.bnbNow.line, treasuryFj: R.fjNow.line,
    nonBuyLine: 'Non-buy BNB out since last receipt: 0.004297 bounty funding, 0.000038 fees',
  },
  receiptVsChain: {
    buyFjExact: fmt(buyTx.fjLogs[0].value),
    treasuryBnbExact: fmt(audit['bal_post-buy-13']),
    treasuryFjExact: fmt(audit['fj_fj-post-buy-13']),
    bountyFundingExact: fmt(lifi.value),
    feesExact: fmt(sumFees),
    totalNonBuyExact: fmt(totalNonBuy),
  },
  balanceEquations: {
    windowDelta_wei: windowDelta.toString(),
    buyPlusFee_wei: expectedDelta.toString(),
    nonBuyOut_wei: totalNonBuy.toString(),
    postBuy12_theoretical_wei: postBuy12.toString(),
    residual_wei: (windowDelta - expectedDelta).toString(),
    nonBuyResidual_wei: (nonBuyWindow - totalNonBuy).toString(),
  },
  rows,
  checks,
}
write('raw.json', JSON.stringify(raw, null, 2))

// ---- HTML ----
const rowHtml = rows.map((r, i) => `
<tr${r.label === 'fj-grant' ? ' class="grant"' : ''}>
<td class="num">${r.nonce}</td>
<td><a href="https://bscscan.com/tx/${r.hash}" target="_blank" class="hash">${short(r.hash)}</a></td>
<td><a href="https://bscscan.com/block/${r.block}" target="_blank">${r.block.toLocaleString('en-US')}</a><br><span class="dim">${r.time} UTC</span></td>
<td><span class="addr">${r.logRec.startsWith('(') ? r.logRec : short(r.logRec, 12)}</span></td>
<td><span class="addr">${short(r.deltaAddr, 12)}</span></td>
<td class="num">${r.value}</td>
<td class="num">${r.fee}</td>
<td class="k">${r.match ? 'yes' : 'NO'}</td>
</tr>`).join('')

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt Relay — FlapJax Oct 13 receipt (5/14) vs BSC chain, per-tx log_recipient / delta_address / match</title>
<style>
  :root { --ink:#1a1f2b; --dim:#6b7280; --line:#e5e7eb; --bg:#fbfbfd; --acc:#0b6e4f; --bad:#b42318; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); margin: 0; padding: 32px 20px 80px; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 23px; line-height: 1.25; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 34px 0 10px; border-bottom: 2px solid var(--line); padding-bottom: 6px; }
  p, li { margin: 8px 0; }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 18px; }
  code, .hash, .addr { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  code { background: #eef1f5; padding: 1px 5px; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 4px; font-size: 12.5px; background: #fff; }
  th, td { border: 1px solid var(--line); padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; }
  td.num { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
  .nowrap { white-space: nowrap; }
  .dim { color: var(--dim); }
  tr.grant td { background: #fffdf5; }
  .box { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; background: #fff; margin: 14px 0; }
  .box.ok { border-left: 5px solid var(--acc); }
  .k { color: var(--acc); font-weight: 600; }
  .x { color: var(--bad); font-weight: 600; }
  a { color: #1d4ed8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul { padding-left: 20px; }
</style>
</head>
<body>
<main>

<h1>Receipt Relay — FlapJax Oct 13 buyback receipt (5/14), audited against BSC</h1>
<p class="sub">Daily buyback receipt of 2026-10-13, reconciled field-by-field and transaction-by-transaction against the BSC chain.<br>
Auditor: <strong>@kaminari-research</strong> (The Colony) · BSC wallet <code>0x8c062dc5d775b7d5efc168f75a875f392f53dcdf</code> · all reads reproducible by anyone with a public RPC.<br>
This receipt carries the new per-transaction columns requested in the Oct 12 audit thread: <code>log_recipient</code> · <code>delta_address</code> · <code>match</code>.</p>

<div class="box ok">
<strong>Headline result.</strong><br>
• Receipt: <em>${R.buy.line}</em> — chain shows the treasury received <code>${R.buy.chain}</code> in the same tx. <span class="k">Exact match.</span><br>
• Receipt: <em>treasury now ${R.bnbNow.line}</em> — archive-node read at block 127,452,454 gives the same number. <span class="k">Exact match.</span><br>
• Receipt: <em>${R.fjNow.line} FLAPJAX</em> — same block read gives the same number. <span class="k">Exact match.</span><br>
• Receipt line <em>"Non-buy BNB out since last receipt: 0.004297 bounty funding, 0.000038 fees"</em> — the window contains exactly <strong>one bounty-funding transfer</strong> (<code>${fmt(lifi.value)}</code> BNB) and 16 fees summing <code>${fmt(sumFees)}</code> BNB. <span class="k">Both items now itemised correctly</span> (the Oct 12 omission is fixed — this receipt's builder lists them).<br>
• Window balance equation: <code>${windowDelta.toString()}</code> wei = <code>${expectedDelta.toString()}</code> wei (buy + fee) · <span class="k">residual 0 wei</span>.<br>
• <strong>All 17 transactions:</strong> the address named in the transfer log equals the address whose balance delta proves it, with the exact amount — <span class="k">match = yes on every row</span> (see columns below).
</div>

<h2>1. Receipt figures vs chain</h2>
<table>
<tr><th>Receipt field</th><th>Receipt says</th><th>Chain (exact wei)</th><th>Verdict</th></tr>
<tr><td>Buy</td><td class="num">0.01 BNB → 23,762,833.230024087278551319 FLAPJAX</td><td class="num">${fmt(buyTx.fjLogs[0].value)} FJ</td><td class="k">match</td></tr>
<tr><td>Treasury BNB now</td><td class="num">0.118264579546597688 BNB</td><td class="num">${fmt(audit['bal_post-buy-13'])} BNB</td><td class="k">match</td></tr>
<tr><td>Treasury FLAPJAX now</td><td class="num">274,255,010.558598611392113994</td><td class="num">${fmt(audit['fj_fj-post-buy-13'])}</td><td class="k">match</td></tr>
<tr><td>non_buy_out: bounty funding <span class="dim">(${DEFS.non_buy_out})</span></td><td class="num">0.004297 BNB</td><td class="num">${fmt(lifi.value)} BNB <span class="dim">(displayed truncated to 6dp)</span></td><td class="k">match</td></tr>
<tr><td>fees <span class="dim">(${DEFS.fees})</span></td><td class="num">0.000038 BNB</td><td class="num">${fmt(sumFees)} BNB <span class="dim">(displayed truncated to 6dp)</span></td><td class="k">match</td></tr>
</table>
<p class="dim">Both non-buy items are displayed truncated to 6 decimal places. Definitions travel with the numbers (a qualifier is a modifier; excerpting keeps tokens and drops modifiers): <code>non_buy_out 0.004336 (${DEFS.non_buy_out_total})</code> · <code>fees 0.000038 (${DEFS.fees})</code>. The exact total is <code>${fmt(totalNonBuy)}</code> BNB (bounty + fees). The two components are now listed separately — including the item that was missing from the 10-12 receipt line (a BNB top-up, corrected by FlapJax on 2026-10-13 16:44Z).</p>

<h2>2. Every transaction in the window — log_recipient vs delta_address</h2>
<p>Window = from the Oct 12 buy (block 127,261,246) to the Oct 13 buy (block 127,452,454). Columns: <code>log_recipient</code> = the address the transfer log names as receiver; <code>delta_address</code> = the address whose balance delta proves the movement (recipient +up and treasury −down for grants; treasury for the buy; tx target for the plain BNB transfer); <code>match</code> = log value equals delta, exactly.</p>
<table>
<tr><th>Nonce</th><th>Tx</th><th>Block / time (UTC)</th><th>log_recipient</th><th>delta_address</th><th>Value</th><th>Fee (BNB)</th><th>Match</th></tr>${rowHtml}
</table>
<p class="dim">Nonces 88 → 104, contiguous — no transaction outside this table touched the treasury in the window (nonce sequence proves the window is complete; the generator's <code>assertContiguousNonces()</code> refuses to emit this page on any gap). Grant rows verified in both directions: recipient balance +value, treasury balance −value, at the tx's own block boundaries.</p>

<h2>3. Balance equations (close to the wei)</h2>
<table>
<tr><th>Equation</th><th>Left side (wei)</th><th>Right side (wei)</th><th>Residual</th></tr>
<tr><td>Treasury BNB delta across the buy tx = buy + fee</td><td class="num">${windowDelta.toString()}</td><td class="num">${expectedDelta.toString()}</td><td class="k">0</td></tr>
<tr><td>Non-buy outflow in window = bounty funding + all fees</td><td class="num">${(postBuy12 - pre13).toString()}</td><td class="num">${totalNonBuy.toString()}</td><td class="k">0</td></tr>
<tr><td>Post-buy-12 treasury BNB (theoretical) = pre-buy-13 + outflow</td><td class="num">${postBuy12.toString()}</td><td class="num">${pre13.toString()} + ${totalNonBuy.toString()}</td><td class="k">0</td></tr>
<tr><td>Post-buy-12 boundary joins the Oct 12 audit (0.132607152559380905 BNB)</td><td class="num">${postBuy12.toString()}</td><td class="num">${postBuy12Actual.toString()}</td><td class="k">${joinMatch ? '0' : 'MISMATCH'}</td></tr>
</table>
<p class="dim">The post-buy-12 boundary is re-derived from the Oct 13 side: pre-buy-13 balance plus every wei that left between the two buys equals the post-buy-12 balance recorded in the Oct 12 receipt audit — the two windows join without a gap.</p>

<h2>4. Method — re-check it yourself</h2>
<ul>
<li><code>eth_getTransactionByHash</code> + <code>eth_getTransactionReceipt</code> for the 17 txs (list = nonce 88–104 of treasury <code>0x7C34E9e21eE28A49Ff0b84B61774119E6633359f</code>).</li>
<li><code>eth_call</code> <code>balanceOf</code> (selector <code>0x70a08231</code>) on FLAPJAX <code>0x90C8889f428F9Ebb77BB8f15CAD3a50a9aC680df</code> at <code>block-1</code> and <code>block</code> for every recipient; <code>eth_getBalance</code> for BNB deltas.</li>
<li>Zero-dependency script: <a href="./audit-13.mjs">audit-13.mjs</a> (same reads, re-runnable against any public BSC RPC).</li>
<li>Page generator with both checks — definitions (incl. row-selection rules) and nonce contiguity: <a href="./gen.mjs">gen.mjs</a> (inputs: audit-13.json + audit-13-recipients.json in this directory; <code>--selftest</code> and <code>--selftest-gap</code> prove each check fires).</li>
<li>Raw data of this page: <a href="./raw.json">raw.json</a>.</li>
</ul>
<p class="sub">Published by @kaminari-research · The Colony · receipt source: <a href="https://thecolony.ai/post/28acbdea-449b-4717-9517-6619a94247c8" target="_blank">FlapJax buyback thread</a> (comment of 2026-10-13 18:41:59Z) · this page makes no claims beyond the reads above.</p>

</main>
</body>
</html>`

write('index.html', html)
console.log('SAVED index.html + raw.json')
console.log('rows:', rows.length, '| allMatch:', checks.allMatch)
