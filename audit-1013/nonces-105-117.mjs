// nonces-105-117.mjs — enumerate every treasury transaction AFTER the Oct 13 audit
// window (nonce >= 105), and close the balance equation across the gap.
//
//   node nonces-105-117.mjs
//
// Answers the reviewer question: "does the transaction history for nonces 104-106
// show any activity that could account for a balance shift without a direct
// transfer?" For an EOA the only balance channels are txs where it is sender or
// receiver; the sender side is fully enumerable from the nonce sequence, the
// receiver side shows up in the balance equation below. Reads via archive RPC,
// binary search on eth_getTransactionCount, no keys.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const RPC = process.env.RPC_URL || 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3'
const FJ = '0x90c8889f428f9ebb77bb8f15cad3a50a9ac680df'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const T = '0x7C34E9e21eE28A49Ff0b84B61774119E6633359f'

async function rpc(method, params) {
  let lastErr
  for (let attempt = 0; attempt < 14; attempt++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const j = await r.json()
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error).slice(0, 100))
      return j.result
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 + attempt * 400)) }
  }
  throw lastErr
}

const audit = JSON.parse(readFileSync(here + 'audit-13.json', 'utf8'))
const START = audit.window.toBlock // last block of the Oct 13 window (buy-13 tx, nonce 104)
const balPost13Wei = BigInt(audit['bal_post-buy-13'])

const latest = Number(await rpc('eth_blockNumber', []))
const cntNow = Number(BigInt(await rpc('eth_getTransactionCount', [T, 'latest'])))
console.log('latest block:', latest, '| current nonce:', cntNow, '| B_post13:', (Number(balPost13Wei) / 1e18).toFixed(18))

const cache = new Map()
async function countAt(b) {
  if (cache.has(b)) return cache.get(b)
  const c = Number(BigInt(await rpc('eth_getTransactionCount', [T, '0x' + b.toString(16)])))
  cache.set(b, c)
  return c
}

let sumOut = 0n, sumFee = 0n, nTx = 0
let searchLo = START + 1
for (let n = 105; n < cntNow; n++) {
  let lo = searchLo, hi = latest
  if ((await countAt(lo)) >= n + 1) { console.log('nonce', n, ': before searchLo (unexpected)'); continue }
  while (lo < hi) { // smallest block where the sender count reaches n+1
    const mid = Math.floor((lo + hi) / 2)
    const c = await countAt(mid)
    if (c >= n + 1) hi = mid; else lo = mid + 1
  }
  searchLo = lo
  const blk = await rpc('eth_getBlockByNumber', ['0x' + lo.toString(16), true])
  const tx = blk.transactions.find(t => t.from.toLowerCase() === T.toLowerCase() && Number(BigInt(t.nonce)) === n)
  if (!tx) { console.log('nonce', n, ': not found in block', lo); continue }
  const rec = await rpc('eth_getTransactionReceipt', [tx.hash])
  const fee = BigInt(rec.gasUsed) * BigInt(rec.effectiveGasPrice || tx.gasPrice)
  sumOut += BigInt(tx.value); sumFee += fee; nTx++
  const ts = new Date(Number(BigInt(blk.timestamp)) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  let fjInfo = ''
  for (const lg of rec.logs || []) {
    if (lg.address.toLowerCase() === FJ && lg.topics[0] === TRANSFER && lg.topics.length === 3) {
      const to = '0x' + lg.topics[2].slice(26)
      const amt = Number(BigInt(lg.data)) / 1e18
      fjInfo += ` | FJ ${amt.toLocaleString('en-US')} -> ${to.slice(0, 10)}…`
    }
  }
  console.log(`nonce ${n} | blk ${lo} | ${ts} | to ${tx.to.slice(0, 12)} | value ${(Number(tx.value) / 1e18).toFixed(9)} | fee ${(Number(fee) / 1e18).toFixed(9)}${fjInfo} | ${tx.hash}`)
}

const balNowWei = BigInt(await rpc('eth_getBalance', [T, 'latest']))
const outWei = sumOut + sumFee
const inWei = balNowWei - balPost13Wei + outWei
console.log('\n=== BALANCE EQUATION (block', START, '->', latest, ') ===')
console.log('outbound txs (nonce 105..' + (cntNow - 1) + '):', nTx)
console.log('B_post13:', (Number(balPost13Wei) / 1e18).toFixed(18))
console.log('B_now   :', (Number(balNowWei) / 1e18).toFixed(18))
console.log('out     :', (Number(outWei) / 1e18).toFixed(18), '(value', (Number(sumOut) / 1e18).toFixed(9), '+ fee', (Number(sumFee) / 1e18).toFixed(9) + ')')
console.log('inferred inbound:', inWei.toString(), 'wei')
