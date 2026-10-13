// q23-audit.mjs — Receipt Relay Q23: enrich 16 tx treasury + balance reads via BSC RPC
// Window: buy 10-11 (block 127067713) -> buy 10-12 (block 127261246)
import { writeFileSync } from 'node:fs'

const RPC = 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3'
const TREASURY = '0x7c34e9e21ee28a49ff0b84b61774119e6633359f'
const FJ = '0x90c8889f428f9ebb77bb8f15cad3a50a9ac680df'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

let idc = 1
async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }) })
      const j = await r.json()
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error))
      return j.result
    } catch (e) {
      if (i === 4) throw e
      await new Promise(r => setTimeout(r, 900))
    }
  }
}
const hex = n => '0x' + BigInt(n).toString(16)

// [hash, block, label]
const TXS = [
  ['0x82d01172ae26f1c86287643e123af1675ca5c18b984b7740c1a0c1647d2801eb', 127067713, 'buy-10-11'],
  ['0xffadd9467036e23f558df95338aad9ffcde86fcf3859fd09303a7d926b17817e', 127145974, 'out'],
  ['0xef4805a7b386055c1aac60c28fa4267190c335aeaae04217a50c705004d98afc', 127145984, 'out'],
  ['0x34a2f8ed9f9db71698d9881e09387ba2bc1997b250b9e7811e3fd737b8f84d50', 127145995, 'out'],
  ['0xc2193a974bf92cb1f908dbfa537c4a21b347a6498f2a46c61c8b48e88e5e9cdd', 127220237, 'out'],
  ['0x9df9a7a9552f8d28c38f9434b9546838b6614f8d8639f8cb39a84780beb22bd5', 127220254, 'out'],
  ['0xdc2b35954374fc028058700f8feadb98d85b9c2b391c185bc5c2846be6f77f01', 127220342, 'out'],
  ['0x25f0688f5eee0421e373dafe0d7c142d411df46f591b062f8a8ab2ff80160f78', 127220352, 'out'],
  ['0xe5e1c5cce7b617a7313d9580dcf43a10001f22df39af939595e5b0de40680542', 127220361, 'out'],
  ['0x99f9709a02f73985710b681c605bc95595b1de91f4989b83f993928cc6e4b28d', 127220370, 'out'],
  ['0x2b9e350db56f6aac54ad7bd44837fb1f3e3e0458e7af5b1d82c03bae48b8fc8a', 127220380, 'out'],
  ['0x12677707569e24cfa728878b46ff4e895fb894da4b39d59f618ab55c9820cc4e', 127220390, 'out'],
  ['0xbc92eaf19ab0c57ab6738532d998591146935ff8d14e3903cb7dae2743030b71', 127220507, 'out'],
  ['0xea9a5fbcaa21ca5f70f17885a3771145b86c002b22a51d60b3fde4dc43565d92', 127221307, 'out'],
  ['0xa5b52de36c7a9167ec2c64a6f49af704e07deddd16a41328f0ade85c9c396837', 127229962, 'out'],
  ['0x9afdc96e3ca876b5b617a26ba5105012ed8c33e805c77b1616bf48c198d5cbf1', 127261246, 'buy-10-12'],
]

const out = { rpc: RPC, treasury: TREASURY, fj: FJ, txs: [], balances: {}, blocks: {}, fjBalances: {} }

for (const [hash, block, label] of TXS) {
  const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])])
  const gasUsed = BigInt(rc.gasUsed)
  const effGasPrice = rc.effectiveGasPrice ? BigInt(rc.effectiveGasPrice) : BigInt(tx.gasPrice)
  const fee = gasUsed * effGasPrice
  const fjLogs = []
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() !== FJ) continue
    if (lg.topics[0] !== TRANSFER_TOPIC) continue
    const from = '0x' + lg.topics[1].slice(26)
    const to = '0x' + lg.topics[2].slice(26)
    const value = BigInt(lg.data === '0x' ? '0x0' : lg.data)
    fjLogs.push({ from, to, value: value.toString() })
  }
  out.txs.push({
    hash, block, label,
    status: rc.status,
    from: tx.from.toLowerCase(),
    to: tx.to ? tx.to.toLowerCase() : null,
    valueWei: BigInt(tx.value).toString(),
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effGasPrice.toString(),
    feeWei: fee.toString(),
    inputSelector: tx.input.slice(0, 10),
    fjLogs,
  })
  console.log('tx', label, hash.slice(0, 12), 'block', block, 'value', (Number(tx.value) / 1e18).toFixed(9), 'gasUsed', gasUsed.toString(), 'fee', (Number(fee) / 1e18).toExponential(6))
  await new Promise(r => setTimeout(r, 250))
}

// balance reads at boundary blocks
const balBlocks = [127067713, 127067714, 127261245, 127261246]
for (const b of balBlocks) {
  const bal = await rpc('eth_getBalance', [TREASURY, hex(b)])
  out.balances[b] = BigInt(bal).toString()
  console.log('BNB treasury @', b, '=', (Number(BigInt(bal)) / 1e18).toFixed(18), bal)
  await new Promise(r => setTimeout(r, 250))
}
// block timestamps for boundaries + all tx blocks
const allBlocks = [...new Set([...TXS.map(t => t[1]), ...balBlocks])].sort((a, b) => a - b)
for (const b of allBlocks) {
  const blk = await rpc('eth_getBlockByNumber', [hex(b), false])
  out.blocks[b] = { timestamp: parseInt(blk.timestamp, 16), iso: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString() }
  await new Promise(r => setTimeout(r, 200))
}
// FJ balanceOf treasury at boundaries (selector 0x70a08231)
const callData = '0x70a08231' + TREASURY.slice(2).padStart(64, '0')
for (const b of [127067713, 127261245, 127261246]) {
  const res = await rpc('eth_call', [{ to: FJ, data: callData }, hex(b)])
  out.fjBalances[b] = BigInt(res).toString()
  console.log('FJ treasury @', b, '=', (Number(BigInt(res)) / 1e18).toFixed(6))
  await new Promise(r => setTimeout(r, 250))
}

writeFileSync('tmp/colony/q23-audit.json', JSON.stringify(out, null, 2))
console.log('SAVED tmp/colony/q23-audit.json')
