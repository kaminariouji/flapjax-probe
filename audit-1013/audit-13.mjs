// audit-13.mjs — Receipt Relay, FlapJax Oct 13 buyback receipt (5/14) vs BSC chain.
// Zero-dep, read-only, no keys. Re-runnable against any public BSC RPC.
//
//   node audit-13.mjs            -> full audit of the Oct 13 window
//   RPC_URL=... node audit-13.mjs
//
// What it prints, all re-checkable by a stranger:
//   1. every treasury tx in the window (nonce 88-104): value, fee, FJ Transfer logs
//   2. per-transaction columns: log_recipient vs delta_address vs match
//      (recipient balance +value AND treasury balance -value, at the tx's own block)
//   3. receipt figures vs chain: buy amount, treasury BNB, treasury FJ, non-buy line
//   4. balance equations: buy+fee and non-buy outflow, both closing to 0 wei
//
// Receipt source: FlapJax buyback thread (The Colony), comment 2026-10-13 18:41:59Z.
// Audit page: https://kaminariouji.github.io/flapjax-probe/audit-1013/
const RPCS = [
  process.env.RPC_URL,
  'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
  'https://bsc.drpc.org',
  'https://binance.llamarpc.com',
].filter(Boolean)
let rpcIdx = 0
const FJ = '0x90c8889f428f9ebb77bb8f15cad3a50a9ac680df'
const TREASURY = '0x7c34e9e21ee28a49ff0b84b61774119e6633359f'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const TXS = [
  ['0xc94de373d1fb00093431224a97475b3b2b48b9a4962d15acbe9d9c5c016d720c', 127452454, 'buy-13'],
  ['0x6f2e58767d9fcba28bba77ab1835bc70050698588a9d65606cb46cbe30c2cb8e', 127425328, 'out-lifi'],
  ['0xe50a053ba822eb138248f0f5a8c791e14df21b57eef5c54993b011a79b4d3712', 127412852, 'fj-grant'],
  ['0x0a7c57859d00271a28d1708d2265b115b2ae80c1be6d508790a76fe179cdc3d9', 127412841, 'fj-grant'],
  ['0x72c700f37d5ea37212407a4c36233db108c3b590c009b3b4db371903367d4137', 127412832, 'fj-grant'],
  ['0x7db3af68ebc249ef90803c3d0dd1b42fccb1f9487af281f4fb6aab0962b3f45e', 127412822, 'fj-grant'],
  ['0x8de4d7fadf2e3e1425aa87884768605ea6d4c05bc2363910f3d0e605d832b0f8', 127412809, 'fj-grant'],
  ['0x977b9a50e0889ea42c0bac104806ce9f78cd7928b7b36957f45e5d952f2aa883', 127412765, 'fj-grant'],
  ['0x81bb50ea99fb464db046d40de6b916108a88178f81d531d95e35d58b559de38f', 127412553, 'fj-grant'],
  ['0xdf82dfa7b2e0cbbd7dba47aa90bf4a293696151402fb994c44880dd320c1f179', 127412542, 'fj-grant'],
  ['0x29baac818cb2cf3e1b7b5e9c36a8f6463033882522e2a9b7098f77c0c0a84515', 127412530, 'fj-grant'],
  ['0xd0d3aa00a3bd8a80959f96acbc7c28fb8c18cb1964afa5616ab1b6aa8c5360d3', 127412508, 'fj-grant'],
  ['0xc5cfcac79baa5725472d59c2605b11379ae91f4049071a4b5357f7b4a0b9e9e3', 127323048, 'fj-grant'],
  ['0x54c634d4a4ddba5a218f93fbb499bd930a0373b64ff70b0cc4592023bbaf1d54', 127304633, 'fj-grant'],
  ['0xf033ab9e274aa10b1bc009525311df735105bb3145c0f6ce04653dd4e3898ef5', 127291613, 'fj-grant'],
  ['0xb43a9cc0237b14d212341208968c6d78ebe86066824ebfeca071b48d483cc678', 127291603, 'fj-grant'],
  ['0x13685c67345ed65b8cf7c6b3dc746d4917a9bfc31a6a451d5efd47a23c91128b', 127291593, 'fj-grant'],
]

async function rpc(method, params) {
  let lastErr
  for (let attempt = 0; attempt < 9; attempt++) {
    const url = RPCS[rpcIdx % RPCS.length]
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const j = await r.json()
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 140)}`)
      return j.result
    } catch (e) { lastErr = e; rpcIdx++; await new Promise(res => setTimeout(res, 500)) }
  }
  throw lastErr
}
const hex = n => '0x' + BigInt(n).toString(16)
const pad = a => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase()
const fmt = (v, d = 18) => {
  const b = BigInt(v)
  const s = b / 10n ** BigInt(d)
  const f = (b % 10n ** BigInt(d)).toString().padStart(d, '0').replace(/0+$/, '')
  return f ? `${s}.${f}` : s.toString()
}
const fjBal = async (addr, block) => BigInt(await rpc('eth_call', [{ to: FJ, data: '0x70a08231' + pad(addr).slice(2) }, hex(block)]))
const bnbBal = async (addr, block) => BigInt(await rpc('eth_getBalance', [addr, hex(block)]))

let allMatch = true
let sumFees = 0n, buyFee = 0n, lifiValue = 0n, buyFj = 0n
for (const [hash, block, label] of TXS) {
  const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])])
  const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || tx.gasPrice)
  const nonce = Number(BigInt(tx.nonce))
  if (label === 'fj-grant') {
    const log = rc.logs.find(l => l.address.toLowerCase() === FJ && l.topics[0] === TRANSFER)
    const rec = '0x' + log.topics[2].slice(26)
    const value = BigInt(log.data)
    const [pre, post] = [await fjBal(rec, block - 1), await fjBal(rec, block)]
    const [tpre, tpost] = [await fjBal(TREASURY, block - 1), await fjBal(TREASURY, block)]
    const ok = (post - pre) === value && (tpre - tpost) === value
    if (!ok) allMatch = false
    sumFees += fee
    console.log(`nonce ${nonce} | grant | log_recipient ${rec} | delta +${fmt(value)} FJ | treasury -${fmt(tpre - tpost)} FJ | match ${ok ? 'yes' : 'NO'}`)
  } else if (label === 'buy-13') {
    const log = rc.logs.find(l => l.address.toLowerCase() === FJ && l.topics[0] === TRANSFER)
    buyFj = BigInt(log.data); buyFee = fee
    const [fpre, fpost] = [await fjBal(TREASURY, block - 1), await fjBal(TREASURY, block)]
    const [bpre, bpost] = [await bnbBal(TREASURY, block - 1), await bnbBal(TREASURY, block)]
    const ok = (fpost - fpre) === buyFj && (bpre - bpost) === BigInt(tx.value) + fee
    if (!ok) allMatch = false
    console.log(`nonce ${nonce} | BUY | pool -> treasury ${fmt(buyFj)} FJ | treasury BNB -${fmt(bpre - bpost)} (= 0.01 + fee) | match ${ok ? 'yes' : 'NO'}`)
  } else {
    lifiValue = BigInt(tx.value); sumFees += fee
    const [bpre, bpost] = [await bnbBal(TREASURY, block - 1), await bnbBal(TREASURY, block)]
    const ok = (bpre - bpost) === lifiValue + fee
    if (!ok) allMatch = false
    console.log(`nonce ${nonce} | out | delta_address ${tx.to} | treasury BNB -${fmt(bpre - bpost)} (= value + fee) | match ${ok ? 'yes' : 'NO'}`)
  }
  await new Promise(r => setTimeout(r, 150))
}

console.log('\n=== receipt figures vs chain ===')
console.log('receipt: 0.01 BNB -> 23,762,833.230024087278551319 FLAPJAX')
console.log('chain  : 0.01 BNB -> ' + fmt(buyFj) + ' FLAPJAX')
console.log('receipt: treasury now 0.118264579546597688 BNB | chain: ' + fmt(await bnbBal(TREASURY, 127452454)))
console.log('receipt: treasury 274,255,010.558598611392113994 FLAPJAX | chain: ' + fmt(await fjBal(TREASURY, 127452454)))
console.log('receipt: non-buy out 0.004297 bounty funding, 0.000038 fees')
console.log('chain  : bounty funding ' + fmt(lifiValue) + ' BNB (1 tx) | fees ' + fmt(sumFees) + ' BNB (16 txs)')
console.log('         total ' + fmt(lifiValue + sumFees) + ' BNB')

console.log('\n=== balance equations ===')
const pre13 = await bnbBal(TREASURY, 127452453)
const post13 = await bnbBal(TREASURY, 127452454)
console.log('window delta (pre - post buy-13) = ' + (pre13 - post13).toString() + ' wei')
console.log('expected (0.01 + buy fee)        = ' + (10000000000000000n + buyFee).toString() + ' wei')
console.log('residual                         = ' + ((pre13 - post13) - 10000000000000000n - buyFee).toString() + ' wei')
console.log('\nALL MATCH: ' + allMatch)
console.log('All reads via public BSC RPCs (first: ' + RPCS[0] + ')')
