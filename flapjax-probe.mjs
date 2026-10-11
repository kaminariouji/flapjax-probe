#!/usr/bin/env node
// flapjax-probe — read-only probe for FLAPJAX on BSC.
// Zero dependencies. Node 18+ (global fetch). No keys, no signing, no writes.
//
// Commands:
//   node flapjax-probe.mjs pool                 pool state, spot, depth +/-2% and +/-5%
//   node flapjax-probe.mjs impact <BNB>         buy price impact for <BNB> in, cross-checked vs QuoterV2
//   node flapjax-probe.mjs balance <address>    FLAPJAX balanceOf + supply share at a named block
//   node flapjax-probe.mjs verify <txhash>      decode every FLAPJAX Transfer in a tx (payout receipt check)
//
// Sources: public BSC JSON-RPC endpoints (4-endpoint fallback, no API keys).

const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-rpc.publicnode.com',
]
// optional: FLAPJAX_PROBE_RPC=https://your-rpc.example  (tried first)
const envRpc = typeof process !== 'undefined' && process.env?.FLAPJAX_PROBE_RPC
if (envRpc) RPCS.unshift(envRpc)

// --- FLAPJAX constants (BSC mainnet) ---
const FLAPJAX = '0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const POOL = '0xcA93EC685b8623688E6B236f9068034B298c2150' // FLAPJAX/WBNB PancakeSwap V3, 1% tier
const QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' // PancakeSwap QuoterV2
const TREASURY = '0x7C34E9e21eE28A49Ff0b84B61774119E6633359f'

// --- selectors (keccak256 of signature, first 4 bytes) ---
const SEL = {
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  factory: '0xc45a0155',
  ticks: '0xf30dba93',
  tickBitmap: '0x5339c296',
  balanceOf: '0x70a08231',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  totalSupply: '0x18160ddd',
  quoteExactInputSingle: '0xc6a5026a',
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n

// --- raw JSON-RPC with endpoint fallback ---
async function rpc(method, params) {
  let lastErr
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(9000),
      })
      const j = await r.json()
      if (j.error) throw new Error(j.error.message)
      return j.result
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error('all RPCs failed: ' + (lastErr?.message || lastErr))
}

const toHexBlock = (n) => '0x' + BigInt(n).toString(16)
const ethCall = (to, data, block) => rpc('eth_call', [{ to, data }, toHexBlock(block)])

// --- ABI word helpers (no library) ---
const pad = (v) => v.toString(16).padStart(64, '0')
const encUint = (n) => '0x' + pad(BigInt(n))
const encInt = (n) => {
  let v = BigInt(n)
  if (v < 0n) v = (1n << 256n) + v
  return '0x' + pad(v)
}
const encAddr = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
function words(ret) {
  const h = ret.replace(/^0x/, '')
  const out = []
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)))
  return out
}
const asAddr = (w) => '0x' + w.toString(16).padStart(40, '0')
const asSigned = (w) => (w >= 1n << 255n ? w - (1n << 256n) : w)
function decodeString(ret) {
  const h = ret.replace(/^0x/, '')
  if (h.length < 128) return ''
  const off = Number(BigInt('0x' + h.slice(0, 64))) * 2
  const len = Number(BigInt('0x' + h.slice(off, off + 64)))
  const bytes = h.slice(off + 64, off + 64 + len * 2).match(/.{1,2}/g) || []
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))))
}

// --- pool reads at a pinned block ---
async function readPool(block) {
  const call = (to, data) => ethCall(to, data, block)
  const [slotRaw, liqRaw, t0Raw, t1Raw, feeRaw, spacingRaw, facRaw] = await Promise.all([
    call(POOL, SEL.slot0),
    call(POOL, SEL.liquidity),
    call(POOL, SEL.token0),
    call(POOL, SEL.token1),
    call(POOL, SEL.fee),
    call(POOL, SEL.tickSpacing),
    call(POOL, SEL.factory),
  ])
  const s = words(slotRaw)
  const tick = Number(asSigned(s[1]))
  const sqrtPriceX96 = s[0]
  const L = Number(words(liqRaw)[0])
  const token0 = asAddr(words(t0Raw)[0])
  const token1 = asAddr(words(t1Raw)[0])
  const fee = Number(words(feeRaw)[0])
  const tickSpacing = Number(asSigned(words(spacingRaw)[0]))
  const factory = asAddr(words(facRaw)[0])

  const decRaw = async (addr) => Number(words(await call(addr, SEL.decimals))[0])
  const symRaw = async (addr) => {
    try { return decodeString(await call(addr, SEL.symbol)) || '?' } catch { return '?' }
  }
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    decRaw(token0), decRaw(token1),
    symRaw(token0), symRaw(token1),
  ])

  const sp0 = Number((sqrtPriceX96 * 10n ** 18n) / (1n << 96n)) / 1e18
  const spot = sp0 * sp0 // token1 per token0 (human units)
  return { block, sqrtPriceX96, tick, L, token0, token1, fee, tickSpacing, factory, dec0, dec1, sym0, sym1, sp0, spot }
}

// --- initialized ticks within [from, to] (tickBitmap + ticks walk) ---
// tickBitmap is indexed on COMPRESSED ticks (tick / tickSpacing), not raw ticks.
async function initTicksIn(p, from, to) {
  const spacing = p.tickSpacing
  const c0 = Math.floor(from / spacing)
  const c1 = Math.floor(to / spacing)
  const w0 = Math.floor(c0 / 256)
  const w1 = Math.floor(c1 / 256)
  const words_ = []
  for (let w = w0; w <= w1; w++) words_.push(w)
  const found = []
  const results = await Promise.all(words_.map((w) => ethCall(POOL, SEL.tickBitmap + encInt(w).slice(2), p.block)))
  results.forEach((ret, i) => {
    const v = words(ret)[0]
    for (let b = 0; b < 256; b++) {
      if ((v >> BigInt(b)) & 1n) {
        const raw = (words_[i] * 256 + b) * spacing
        if (raw >= from && raw <= to) found.push(raw)
      }
    }
  })
  found.sort((a, b) => a - b)
  const data = {}
  const tickRets = await Promise.all(found.map((t) => ethCall(POOL, SEL.ticks + encInt(t).slice(2), p.block)))
  found.forEach((t, i) => {
    const w = words(tickRets[i])
    data[t] = { gross: w[0], net: Number(asSigned(w[1])) }
  })
  return { ticks: found, data }
}
const tickNetOf = (scan, t) => scan.data[t]?.net ?? 0
const sqrtPAt = (t) => Math.pow(1.0001, t / 2)

// --- depth: amount needed to move the price by a ratio (0.98 = -2%, 1.05 = +5%) ---
// Returns both sides of the move. Input amounts are NET (fee-excluded): the amount
// the curve itself absorbs. Multiply by 1/(1-fee) for the gross trader cost.
function depthDown(p, scan, ratio) {
  const spT = p.sp0 * Math.sqrt(ratio)
  const tT = (2 * Math.log(spT)) / Math.log(1.0001)
  const bounds = scan.ticks.filter((t) => t <= p.tick && t >= tT).sort((a, b) => b - a)
  let L = p.L, cur = p.sp0, amt0 = 0, amt1 = 0, crossed = 0
  for (const t of bounds) {
    const spt = sqrtPAt(t)
    amt0 += L * (1 / spt - 1 / cur)
    amt1 += L * (cur - spt)
    cur = spt
    L -= tickNetOf(scan, t)
    crossed++
    if (L <= 0) break
  }
  if (L > 0) {
    amt0 += L * (1 / spT - 1 / cur)
    amt1 += L * (cur - spT)
  }
  return { amountToken0: amt0 / 10 ** p.dec0, amountToken1: amt1 / 10 ** p.dec1, crossed }
}
function depthUp(p, scan, ratio) {
  const spT = p.sp0 * Math.sqrt(ratio)
  const tT = (2 * Math.log(spT)) / Math.log(1.0001)
  const bounds = scan.ticks.filter((t) => t > p.tick && t <= tT).sort((a, b) => a - b)
  let L = p.L, cur = p.sp0, amt1 = 0, amt0 = 0, crossed = 0
  for (const t of bounds) {
    const spt = sqrtPAt(t)
    amt1 += L * (spt - cur)
    amt0 += L * (1 / cur - 1 / spt)
    cur = spt
    L += tickNetOf(scan, t)
    crossed++
    if (L <= 0) break
  }
  if (L > 0) {
    amt1 += L * (spT - cur)
    amt0 += L * (1 / cur - 1 / spT)
  }
  return { amountToken1: amt1 / 10 ** p.dec1, amountToken0: amt0 / 10 ** p.dec0, crossed }
}

// --- buy simulation (WBNB in -> FLAPJAX out), tick-walking with the 1% fee ---
function simBuy(p, scan, amountInHuman) {
  const amountIn = amountInHuman * 10 ** p.dec1
  const feePct = p.fee / 1e6
  let rem = amountIn * (1 - feePct)
  let L = p.L, cur = p.sp0, out0 = 0, crossed = 0, spFinal = cur
  const bounds = scan.ticks.filter((t) => t > p.tick).sort((a, b) => a - b)
  for (const t of bounds) {
    const spt = sqrtPAt(t)
    const capY = L * (spt - cur)
    if (rem <= capY) {
      spFinal = cur + rem / L
      out0 += L * (1 / cur - 1 / spFinal)
      rem = 0
      break
    }
    out0 += L * (1 / cur - 1 / spt)
    rem -= capY
    L += tickNetOf(scan, t)
    cur = spt
    spFinal = cur
    crossed++
    if (L <= 0) break
  }
  if (rem > 0 && L > 0) {
    spFinal = cur + rem / L
    out0 += L * (1 / cur - 1 / spFinal)
  }
  const outHuman = out0 / 10 ** p.dec0
  const avgExec = amountInHuman / outHuman
  return {
    amountIn: amountInHuman,
    amountOut: outHuman,
    crossed,
    avgExecPrice: avgExec,
    impactPct: (avgExec / p.spot - 1) * 100, // vs spot, includes the 1% fee
    priceAfter: spFinal * spFinal,
  }
}

// --- QuoterV2 cross-check (same block) ---
async function quoteBuy(p, amountInHuman) {
  const amountIn = BigInt(Math.round(amountInHuman * 1e18)) // WBNB has 18 decimals
  const data =
    SEL.quoteExactInputSingle +
    encAddr(WBNB).slice(2) +
    encAddr(FLAPJAX).slice(2) +
    pad(amountIn) +
    pad(p.fee) +
    pad(MAX_SQRT_RATIO - 1n)
  const ret = await ethCall(QUOTER, '0x' + data.replace(/^0x/, ''), p.block)
  const w = words(ret)
  const out = Number(w[0]) / 10 ** p.dec0
  return { amountOut: out, ticksCrossed: Number(w[2]), avgExecPrice: amountInHuman / out }
}

// --- commands ---
async function latestBlock() {
  return Number(BigInt(await rpc('eth_blockNumber', [])))
}

async function cmdPool() {
  const now = await latestBlock()
  const block = now - 5
  const blk = await rpc('eth_getBlockByNumber', [toHexBlock(block), false])
  const ts = new Date(Number(BigInt(blk.timestamp)) * 1000).toISOString()
  const p = await readPool(block)
  const span = Math.ceil((2 * Math.log(1.05)) / Math.log(1.0001)) + 256
  const scan = await initTicksIn(p, p.tick - span, p.tick + span)
  const d2 = depthDown(p, scan, 0.98)
  const d5 = depthDown(p, scan, 0.95)
  const u2 = depthUp(p, scan, 1.02)
  const u5 = depthUp(p, scan, 1.05)

  const label = (a, b) => `${a}/${b}`
  console.log(`FLAPJAX probe — pool state at BSC block ${block} (${ts})`)
  console.log(`pool        ${POOL}`)
  console.log(`pair        ${label(p.sym0, p.sym1)}  (token0=${p.token0} token1=${p.token1})`)
  console.log(`fee tier    ${p.fee / 10000}%  (${p.fee})   tickSpacing ${p.tickSpacing}   factory ${p.factory}`)
  console.log(`tick        ${p.tick}   sqrtPriceX96 ${p.sqrtPriceX96}`)
  console.log(`spot        1 ${p.sym0} = ${p.spot.toExponential(6)} ${p.sym1}    |    1 ${p.sym1} = ${(1 / p.spot).toExponential(6)} ${p.sym0}`)
  console.log(`liquidity   L = ${p.L.toExponential(6)}  (active, in-range)`)
  console.log(`init ticks  ${scan.ticks.length} initialized within +/-${span} of current tick`)
  console.log('')
  console.log(`depth -2%   ${Math.round(d2.amountToken0).toLocaleString('en-US')} ${p.sym0} sold to move price down 2%`)
  console.log(`depth -5%   ${Math.round(d5.amountToken0).toLocaleString('en-US')} ${p.sym0} sold to move price down 5%`)
  console.log(`depth +2%   ${u2.amountToken1.toFixed(4)} ${p.sym1} bought to move price up 2%`)
  console.log(`depth +5%   ${u5.amountToken1.toFixed(4)} ${p.sym1} bought to move price up 5%`)
  console.log('')
  const wide = await initTicksIn(p, p.tick - 12000, p.tick + 12000)
  const above = wide.ticks.filter((t) => t > p.tick)
  const below = wide.ticks.filter((t) => t <= p.tick)
  const na = above.length ? Math.min(...above) : null
  const nb = below.length ? Math.max(...below) : null
  const pct = (t) => ((Math.pow(1.0001, t - p.tick) - 1) * 100).toFixed(1)
  console.log(`next ticks  nearest initialized tick above: ${na === null ? 'none within 12k' : na + '  (' + (pct(na) >= 0 ? '+' : '') + pct(na) + '% price)'}`)
  console.log(`            nearest initialized tick below: ${nb === null ? 'none within 12k' : nb + '  (' + pct(nb) + '% price)'}`)
  console.log('')
  console.log(`note        depth is computed by walking initialized ticks from pool state; it is a`)
  console.log(`            static read, not a quote. Fees are not included in the depth figures`)
  console.log(`            (run 'depth' to see the same numbers with and without the fee).`)
}

async function cmdDepth() {
  const now = await latestBlock()
  const block = now - 5
  const blk = await rpc('eth_getBlockByNumber', [toHexBlock(block), false])
  const ts = new Date(Number(BigInt(blk.timestamp)) * 1000).toISOString()
  const p = await readPool(block)
  const span = Math.ceil((2 * Math.log(1.05)) / Math.log(1.0001)) + 256
  const scan = await initTicksIn(p, p.tick - span, p.tick + span)
  const d2 = depthDown(p, scan, 0.98)
  const d5 = depthDown(p, scan, 0.95)
  const u2 = depthUp(p, scan, 1.02)
  const u5 = depthUp(p, scan, 1.05)
  const feeMult = 1 - p.fee / 1e6
  const g = (x, dec) => (x / feeMult).toLocaleString('en-US', { maximumFractionDigits: dec })
  const n = (x, dec) => x.toLocaleString('en-US', { maximumFractionDigits: dec })
  console.log(`FLAPJAX depth — BOTH fee conventions shown — BSC block ${block} (${ts})`)
  console.log(`pool ${POOL}`)
  console.log(`fee ${p.fee / 10000}%  tick ${p.tick}  L ${p.L.toExponential(6)}  spot 1 ${p.sym0} = ${p.spot.toExponential(6)} ${p.sym1}`)
  console.log('')
  console.log('move   in NET (curve absorbs)      in GROSS (trader pays)      out (no fee on output)')
  console.log(`-2%    ${n(d2.amountToken0, 2).padEnd(26)} ${g(d2.amountToken0, 2).padEnd(26)} ${d2.amountToken1.toFixed(6)} ${p.sym1}`)
  console.log(`-5%    ${n(d5.amountToken0, 2).padEnd(26)} ${g(d5.amountToken0, 2).padEnd(26)} ${d5.amountToken1.toFixed(6)} ${p.sym1}`)
  console.log(`+2%    ${n(u2.amountToken1, 6).padEnd(26)} ${g(u2.amountToken1, 6).padEnd(26)} ${n(u2.amountToken0, 2)} ${p.sym0}`)
  console.log(`+5%    ${n(u5.amountToken1, 6).padEnd(26)} ${g(u5.amountToken1, 6).padEnd(26)} ${n(u5.amountToken0, 2)} ${p.sym0}`)
  console.log('')
  console.log('note   "NET" is the amount the curve itself absorbs (fee excluded); "GROSS" is what a')
  console.log(`       trader must spend so that NET reaches the curve: gross = net / ${feeMult.toFixed(2)}.`)
  console.log('       Two reports that differ by exactly the pool fee are using different conventions,')
  console.log('       not disagreeing about the pool. Output side pays no fee, so it matches either way.')
  console.log(`       ticks crossed: -2% ${d2.crossed}, -5% ${d5.crossed}, +2% ${u2.crossed}, +5% ${u5.crossed} (0 = single constant-L segment)`)
}

async function cmdImpact(args) {
  const bnb = Number(args[0])
  if (!(bnb > 0)) throw new Error('usage: impact <BNB>  e.g. impact 0.1')
  const now = await latestBlock()
  const block = now - 5
  const p = await readPool(block)
  const span = 4000
  const scan = await initTicksIn(p, p.tick - span, p.tick + span)
  const sim = simBuy(p, scan, bnb)
  const q = await quoteBuy(p, bnb).catch((e) => ({ error: e.message }))
  console.log(`buy impact — ${bnb} BNB in, at BSC block ${block}`)
  console.log(`walk        ${Math.round(sim.amountOut).toLocaleString('en-US')} ${p.sym0} out | ticks crossed ${sim.crossed} | avg exec ${sim.avgExecPrice.toExponential(6)} ${p.sym1}/${p.sym0}`)
  console.log(`impact      ${sim.impactPct.toFixed(3)}% vs spot (includes ${p.fee / 10000}% pool fee) | price after: ${sim.priceAfter.toExponential(6)} ${p.sym1}/${p.sym0}`)
  if (q.error) {
    console.log(`quoter      unavailable: ${q.error}`)
  } else {
    const diff = ((q.amountOut / sim.amountOut - 1) * 100).toFixed(3)
    console.log(`quoter V2   ${Math.round(q.amountOut).toLocaleString('en-US')} ${p.sym0} out | ticks crossed ${q.ticksCrossed} | delta vs walk: ${diff}%`)
  }
}

async function cmdBalance(args) {
  const addr = args[0]
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) throw new Error('usage: balance <0x address>')
  const now = await latestBlock()
  const block = now - 5
  const [balRaw, supRaw] = await Promise.all([
    ethCall(FLAPJAX, SEL.balanceOf + encAddr(addr).slice(2), block),
    ethCall(FLAPJAX, SEL.totalSupply, block),
  ])
  const bal = Number(words(balRaw)[0]) / 1e18
  const sup = Number(words(supRaw)[0]) / 1e18
  console.log(`FLAPJAX balance read — block ${block}`)
  console.log(`address     ${addr}`)
  console.log(`balanceOf   ${bal.toLocaleString('en-US', { maximumFractionDigits: 4 })} FLAPJAX`)
  console.log(`totalSupply ${sup.toLocaleString('en-US', { maximumFractionDigits: 4 })} FLAPJAX`)
  console.log(`share       ${((bal / sup) * 100).toFixed(8)}% of supply`)
  console.log(`token       ${FLAPJAX} (BEP-20, BSC)`)
}

async function cmdVerify(args) {
  const txHash = args[0]
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new Error('usage: verify <0x txhash>')
  const [tx, rc] = await Promise.all([
    rpc('eth_getTransactionByHash', [txHash]),
    rpc('eth_getTransactionReceipt', [txHash]),
  ])
  if (!rc) throw new Error('tx not found (or not mined)')
  console.log(`FLAPJAX payout check — tx ${txHash}`)
  console.log(`block       ${Number(BigInt(rc.blockNumber))}   status ${rc.status === '0x1' ? 'success' : 'FAILED'}   from ${tx.from}`)
  const transfers = (rc.logs || []).filter(
    (l) => l.address.toLowerCase() === FLAPJAX.toLowerCase() && l.topics[0] === TRANSFER_TOPIC,
  )
  if (!transfers.length) {
    console.log('transfers   none (this tx contains no FLAPJAX Transfer log)')
    return
  }
  for (const l of transfers) {
    const from = '0x' + l.topics[1].slice(26)
    const to = '0x' + l.topics[2].slice(26)
    const val = Number(BigInt(l.data)) / 1e18
    const tag = from.toLowerCase() === TREASURY.toLowerCase() ? '  [from FlapJax treasury]' : ''
    console.log(`transfer    ${val.toLocaleString('en-US', { maximumFractionDigits: 4 })} FLAPJAX  ${from} -> ${to}${tag}`)
  }
  console.log(`token       ${FLAPJAX}   log count ${rc.logs.length}`)
}

// --- FlapJax Agent/Wallet Checker (x402) — integration ---
// GET /check returns HTTP 402 with a PAYMENT-REQUIRED header (base64 x402 v2 challenge).
// This command handles that challenge correctly and never spends: it decodes the terms
// and stops. A paid 200 response (if you ever send one yourself) is summarized too.
const CHECKER = 'https://flapjax-check.run402.com'

function decodePaymentRequired(res) {
  const raw = res.headers.get('payment-required')
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

const fmtUsdc = (micros) => {
  const n = Number(micros) / 1e6
  return Number.isFinite(n) ? `${n} USDC` : String(micros)
}

async function cmdCheck(args) {
  const addr = args.find((a) => !a.startsWith('--'))
  const asJson = args.includes('--json')
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) throw new Error('usage: check <0x address> [--json]')
  const url = `${CHECKER}/check?address=${addr}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const bodyText = await res.text()
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    body = bodyText.slice(0, 400)
  }
  const challenge = decodePaymentRequired(res)

  if (asJson) {
    console.log(JSON.stringify({ httpStatus: res.status, url, challenge, body }, null, 2))
    return
  }

  console.log('FlapJax Agent/Wallet Checker — x402 integration (read-only, no payment sent)')
  console.log(`call        GET ${url}`)
  console.log(`http        ${res.status}${res.status === 402 ? '  (payment required — the expected free response)' : ''}`)

  if (res.status === 402 && challenge) {
    const r = challenge.resource || {}
    const acc = (challenge.accepts || [])[0] || {}
    console.log(`service     ${r.serviceName || '-'}  (x402Version ${challenge.x402Version})`)
    console.log(`about       ${r.description || '-'}`)
    console.log(`tags        ${(r.tags || []).join(', ')}`)
    console.log('')
    console.log(`payment     scheme ${acc.scheme}  network ${acc.network}  (eip155:8453 = Base mainnet)`)
    console.log(`price       ${fmtUsdc(acc.amount)}  asset ${acc.asset} (${acc.extra?.name || '?'})`)
    console.log(`payTo       ${acc.payTo}`)
    console.log(`timeout     ${acc.maxTimeoutSeconds}s  route ${acc.extra?.run402_payment_kind || '-'}`)
    const ex = challenge.extensions?.bazaar?.info?.output?.example
    if (ex) console.log(`would return ${JSON.stringify(ex)}`)
    console.log('')
    const why = body?.next_actions?.[0]?.why
    console.log(`gateway     ${body?.code || '-'}${body?.retryable === false ? '  retryable:false' : ''}${why ? ' — ' + why : ''}`)
    console.log('')
    console.log('note        this probe never spends: it decodes the challenge and stops. Free calls')
    console.log('            that need no payment: /related-sample?chain=bsc|base, /fj/balance?wallet=0x...')
  } else if (res.status === 200 && body) {
    console.log(`result      address ${body.address || addr}`)
    if (body.agent_likeness) console.log(`agent score ${body.agent_likeness.score}`)
    if (body.sybil) console.log(`sybil       cluster_flag ${body.sybil.cluster_flag}`)
    if (body.flapjax) console.log(`flapjax     holds ${body.flapjax.holds}`)
    console.log(`raw         ${JSON.stringify(body).slice(0, 300)}`)
  } else {
    console.log(`body        ${JSON.stringify(body).slice(0, 300)}`)
  }
}

// --- entry ---
const [cmd, ...args] = process.argv.slice(2)
const usage = `flapjax-probe — read-only FLAPJAX on-chain probe (BSC)

  node flapjax-probe.mjs pool                 pool state, spot, depth +/-2% and +/-5%
  node flapjax-probe.mjs depth                depth with BOTH fee conventions (net vs gross)
  node flapjax-probe.mjs impact <BNB>         buy impact, cross-checked vs QuoterV2
  node flapjax-probe.mjs balance <address>    balanceOf + supply share at a named block
  node flapjax-probe.mjs verify <txhash>      decode FLAPJAX Transfers in a tx
  node flapjax-probe.mjs check <address>      FlapJax Agent/Wallet Checker (x402): handle the
                                              free 402 challenge, print the terms. Never pays.

No keys. No signing. Reads public BSC RPCs only.`

try {
  if (cmd === 'pool') await cmdPool()
  else if (cmd === 'depth') await cmdDepth()
  else if (cmd === 'impact') await cmdImpact(args)
  else if (cmd === 'balance') await cmdBalance(args)
  else if (cmd === 'verify') await cmdVerify(args)
  else if (cmd === 'check') await cmdCheck(args)
  else console.log(usage)
} catch (e) {
  console.error('error:', e.message)
  process.exit(1)
}
