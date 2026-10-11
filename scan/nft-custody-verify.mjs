// nft-custody-verify.mjs — ground truth custody: ownerOf + positions() untuk 1456181 & 5144842 di PancakeSwap V3 NPM
import { ethers } from 'ethers'

const RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com']
const NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' // PancakeSwap V3 NonfungiblePositionManager (BSC)
const LOCKER = '0x25c9c4b56e820e0dea438b145284f02d9ca9bd52'
const FLAPJAX = '0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const POOL_FJ = '0xcA93EC685b8623688E6B236f9068034B298c2150'
const IDS = [1456181n, 5144842n]

let provider
for (const url of RPCS) {
  try { const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true }); await p.getBlockNumber(); provider = p; break } catch (e) {}
}
const BLOCK = await provider.getBlockNumber()
console.log('block:', BLOCK, '\n')

const iface = new ethers.Interface([
  'function ownerOf(uint256) view returns (address)',
  'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
])
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'])

const NAMES = { [FLAPJAX.toLowerCase()]: 'FLAPJAX', [WBNB.toLowerCase()]: 'WBNB' }

for (const id of IDS) {
  console.log('=== NFT', id.toString(), '===')
  try {
    const o = await provider.call({ to: NPM, data: iface.encodeFunctionData('ownerOf', [id]) })
    const owner = ethers.getAddress('0x' + o.slice(26))
    const ownerCode = await provider.getCode(owner)
    console.log('ownerOf:', owner, '| EOA/contract:', ownerCode === '0x' ? 'EOA' : 'contract (' + (ownerCode.length - 2) / 2 + ' bytes)', '| = locker?', owner.toLowerCase() === LOCKER)
  } catch (e) { console.log('ownerOf ERR:', (e.shortMessage || e.message).slice(0, 100)) }

  try {
    const p = await provider.call({ to: NPM, data: iface.encodeFunctionData('positions', [id]) })
    const pos = iface.decodeFunctionResult('positions', p)
    const t0 = ethers.getAddress(pos.token0), t1 = ethers.getAddress(pos.token1)
    console.log('token0:', t0, NAMES[t0.toLowerCase()] || '?')
    console.log('token1:', t1, NAMES[t1.toLowerCase()] || '?')
    console.log('fee:', pos.fee.toString(), '| tickLower:', pos.tickLower.toString(), '| tickUpper:', pos.tickUpper.toString())
    console.log('liquidity:', pos.liquidity.toString())
    console.log('tokensOwed0:', pos.tokensOwed0.toString(), '| tokensOwed1:', pos.tokensOwed1.toString())
    console.log('same pool FLAPJAX/WBNB?', (t0.toLowerCase() === FLAPJAX.toLowerCase() && t1.toLowerCase() === WBNB.toLowerCase()) || (t1.toLowerCase() === FLAPJAX.toLowerCase() && t0.toLowerCase() === WBNB.toLowerCase()))
  } catch (e) { console.log('positions ERR:', (e.shortMessage || e.message).slice(0, 100)) }
  console.log()
}

// saldo locker
console.log('=== locker balances ===')
for (const [name, addr] of [['FLAPJAX', FLAPJAX], ['WBNB', WBNB]]) {
  const b = BigInt(await provider.call({ to: addr, data: erc20.encodeFunctionData('balanceOf', [LOCKER]) }))
  console.log('locker', name + ':', ethers.formatEther(b))
}
