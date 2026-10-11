// verify-buyback.mjs — REVIEW reproducible: verifikasi on-chain program buyback FlapJax.
// RPC: bsc-dataseed.binance.org (receipts OK; getLogs archive tidak tersedia → masuk "unmeasured")
// Output: tmp/flapjax-review/buyback-data.json + ringkasan stdout.
import { writeFileSync, mkdirSync } from 'node:fs'

const FLAPJAX = '0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df'
const TREASURY = '0x7C34E9e21eE28A49Ff0b84B61774119E6633359f'
const POOL = '0xcA93EC685b8623688E6B236f9068034B298c2150'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TOPIC_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const TXS = {
  ref_oct8: '0x3cec62e37b0b0fc60baa6449d38939c1d6a23446af0b5ce7247da8b3a6417fea',
  day1_oct9: '0xbeefabdc89f9148f9daaef6082d34a60dc5b4b612972ca0fd39d6bd4eb03b4b0',
  day2_oct10: '0x8ce8e8578da26f8c7acb0f44c6ca0d0b8dcba868cafe2d729bb48562863f2d62',
}
// Angka yang DIKLAIM publik di receipt (thread Colony 28acbdea):
const POSTED = {
  day1_oct9: { fj: 24052995n, bnbAfter: '0.1769', fjAfter: 199900085n },
  day2_oct10: { fj: 23979959n, bnbAfter: '0.1547', fjAfter: 223130044n },
}
const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-mainnet.public.blastapi.io',
]

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${url}: ${JSON.stringify(j.error).slice(0, 160)}`)
  return j.result
}
async function rpcAny(method, params, label) {
  let lastErr
  for (const u of RPCS) {
    try { return await rpc(u, method, params) } catch (e) { lastErr = e }
  }
  throw new Error(`${label}: all RPC failed: ${lastErr?.message}`)
}

const pad = (v) => BigInt(v).toString(16).padStart(64, '0')
const E18 = 10n ** 18n
const word2addr = (w) => '0x' + w.slice(26).toLowerCase()
const word2big = (w) => BigInt(w.startsWith('0x') ? w : '0x' + w)
const fmt = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 })

async function main() {
  const out = { generatedAt: new Date().toISOString(), txs: {}, balances: {}, check: {}, derived: {} }

  for (const [key, hash] of Object.entries(TXS)) {
    const tx = await rpcAny('eth_getTransactionByHash', [hash], key)
    const rc = await rpcAny('eth_getTransactionReceipt', [hash], key)
    const blk = await rpcAny('eth_getBlockByNumber', [tx.blockNumber, false], key)
    const rec = {
      hash, blockNumber: parseInt(tx.blockNumber, 16), status: rc.status,
      from: tx.from.toLowerCase(), to: tx.to.toLowerCase(),
      valueBNB: BigInt(tx.value).toString(),
      gasUsed: BigInt(rc.gasUsed).toString(),
      effGasPrice: BigInt(rc.effectiveGasPrice || rc.gasPrice).toString(),
      gasCostBNB: (BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || rc.gasPrice)).toString(),
      timestamp: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(),
      flapjaxToTreasury: null, flapjaxFromTreasury: null, wbnbTransfers: [], swap: null, approvals: [],
    }
    for (const log of rc.logs) {
      if (log.address.toLowerCase() === FLAPJAX.toLowerCase() && log.topics[0] === TOPIC_TRANSFER) {
        const from = word2addr(log.topics[1]), to = word2addr(log.topics[2]), amt = word2big(log.data)
        if (to === TREASURY.toLowerCase()) rec.flapjaxToTreasury = amt.toString()
        if (from === TREASURY.toLowerCase()) rec.flapjaxFromTreasury = amt.toString()
      }
      if (log.address.toLowerCase() === WBNB.toLowerCase() && log.topics[0] === TOPIC_TRANSFER) {
        rec.wbnbTransfers.push({ from: word2addr(log.topics[1]), to: word2addr(log.topics[2]), amt: word2big(log.data).toString() })
      }
      if (log.address.toLowerCase() === POOL.toLowerCase() && log.topics[0] === TOPIC_SWAP) {
        const [a0, a1] = [log.data.slice(2, 66), log.data.slice(66, 130)]
        rec.swap = { amount0: BigInt('0x' + a0).toString(), amount1: BigInt('0x' + a1).toString(), sender: word2addr(log.topics[1]) }
      }
    }
    out.txs[key] = rec
  }

  // Balances terkini
  out.headBlock = parseInt(await rpcAny('eth_blockNumber', [], 'head'), 16)
  out.balances.bnbTreasury = BigInt(await rpcAny('eth_getBalance', [TREASURY, 'latest'], 'bnb')).toString()
  out.balances.fjTreasury = BigInt(await rpcAny('eth_call', [{ to: FLAPJAX, data: '0x70a08231' + pad(TREASURY) }, 'latest'], 'fj')).toString()
  out.balances.fjOurs = BigInt(await rpcAny('eth_call', [{ to: FLAPJAX, data: '0x70a08231' + pad('0x8c062dc5d775b7d5efc168f75a875f392f53dcdf') }, 'latest'], 'fj2')).toString()

  // Cek 1: tx = dari treasury, ke SwapRouter, nilai sesuai klaim, status sukses
  out.check.txs = {}
  for (const [key, rec] of Object.entries(out.txs)) {
    out.check.txs[key] = {
      fromTreasury: rec.from === TREASURY.toLowerCase(),
      toSwapRouter: rec.to === '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
      statusOk: rec.status === '0x1',
      valueBNB: rec.valueBNB,
      flapjaxReceived: rec.flapjaxToTreasury,
      postedMatch: POSTED[key] ? BigInt(rec.flapjaxToTreasury || '0') / E18 >= POSTED[key].fj && BigInt(rec.flapjaxToTreasury || '0') / E18 < POSTED[key].fj + 1n : null,
      gasCostBNB: rec.gasCostBNB,
      swapDirection: rec.swap ? { amount0: rec.swap.amount0, amount1: rec.swap.amount1, note: 'amount0 = FLAPJAX (token0) in/out; negative = keluar pool' } : null,
    }
  }

  // Cek 2: rekonsiliasi saldo antar receipt + sekarang
  const r1 = POSTED.day1_oct9, r2 = POSTED.day2_oct10
  out.check.reconciliation = {
    receipt1_fjAfter: (r1.fjAfter * E18).toString(),
    buy2_plus: (r2.fj * E18).toString(),
    receipt2_fjAfter: (r2.fjAfter * E18).toString(),
    implied_payout_between_receipts: ((r1.fjAfter + r2.fj - r2.fjAfter) * E18).toString(),
    now_fj: out.balances.fjTreasury,
    implied_payouts_since_receipt2: (r2.fjAfter * E18 - BigInt(out.balances.fjTreasury)).toString(),
    bnbTreasuryNow: out.balances.bnbTreasury,
    bnbDeltaSinceReceipt2: (BigInt(r2.bnbAfter.replace('.', '')) * 10n ** 14n - BigInt(out.balances.bnbTreasury)).toString(),
  }

  // Cek 4: mid price pool SEKARANG (slot0) + proyeksi skip rule
  try {
    const slot0 = await rpcAny('eth_call', [{ to: POOL, data: '0x3850c7bd' }, 'latest'], 'slot0')
    const sqrtP = BigInt('0x' + slot0.slice(2, 66))
    const Q96 = 2n ** 96n
    const priceWbnbPerFj = Number(sqrtP * 10n ** 18n / Q96) ** 2 / 1e36
    out.derived.midNow = { sqrtPriceX96: sqrtP.toString(), wbnbPerFj: priceWbnbPerFj, fjPerBNB: 1 / priceWbnbPerFj }
  } catch (e) { out.derived.midNow = { error: e.message.slice(0, 120) } }
  const bnbNow = Number(out.balances.bnbTreasury) / 1e18
  out.derived.skipRuleProjection = {
    bnbNow, floor: 0.025, buysRemaining: 11, bnbForRemainingBuys: 0.11,
    projectedBnbAfterLastBuy: bnbNow - 0.11,
    floorWouldBeHit: bnbNow - 0.11 < 0.025,
  }

  // Cek 3: harga efektif per buy
  out.derived ||= {}
  for (const [key, rec] of Object.entries(out.txs)) {
    if (rec.flapjaxToTreasury && BigInt(rec.valueBNB) > 0n) {
      const fj = BigInt(rec.flapjaxToTreasury), bnb = BigInt(rec.valueBNB)
      out.derived[key] = {
        fjPerBNB: Number(fj * 10n ** 18n / bnb) / 1e18,
        bnbPerFJ: Number(bnb * 10n ** 18n / fj) / 1e18,
      }
    }
  }
  const d9 = out.derived.day1_oct9?.fjPerBNB, d10 = out.derived.day2_oct10?.fjPerBNB
  if (d9 && d10) out.derived.priceChangeBetweenBuysPct = ((d10 / d9 - 1) * 100).toFixed(4)

  mkdirSync('tmp/flapjax-review', { recursive: true })
  writeFileSync('tmp/flapjax-review/buyback-data.json', JSON.stringify(out, null, 1))

  // Ringkasan
  console.log('=== TX CHECKS ===')
  for (const [k, c] of Object.entries(out.check.txs)) {
    console.log(`${k}: fromTreasury=${c.fromTreasury} toRouter=${c.toSwapRouter} status=${c.statusOk} value=${fmt(c.valueBNB)} BNB got=${c.flapjaxReceived ? fmt(c.flapjaxReceived) : '?'} FJ match=${c.postedMatch} gas=${fmt(c.gasCostBNB)} BNB`)
  }
  console.log('=== RECONCILIATION ===')
  const rc2 = out.check.reconciliation
  console.log(`receipt1 FJ after: ${fmt(rc2.receipt1_fjAfter)}`)
  console.log(`+ buy2:            ${fmt(rc2.buy2_plus)}`)
  console.log(`= expect:          ${fmt((BigInt(rc2.receipt1_fjAfter) + BigInt(rc2.buy2_plus)).toString())}`)
  console.log(`receipt2 posted:   ${fmt(rc2.receipt2_fjAfter)}  → implied payout in window: ${fmt(rc2.implied_payout_between_receipts)}`)
  console.log(`treasury FJ now:   ${fmt(rc2.now_fj)}  → outflows since receipt2: ${fmt(rc2.implied_payouts_since_receipt2)}`)
  console.log(`treasury BNB now:  ${fmt(rc2.bnbTreasuryNow)}  → delta since receipt2: ${fmt(rc2.bnbDeltaSinceReceipt2)}`)
  console.log('=== DERIVED ===')
  for (const [k, v] of Object.entries(out.derived)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
  console.log('head block:', out.headBlock)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
