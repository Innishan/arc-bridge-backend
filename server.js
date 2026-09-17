import express from 'express'
import cors from 'cors'
import fs from 'fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPublicClient, decodeEventLog, formatUnits, http, padHex } from 'viem'

const app = express()
app.use(cors())
app.use(express.json())

const DATA_FILE = process.env.DATA_FILE || './bridges.json'
const ENVIRONMENTS = new Set(['testnet', 'mainnet'])
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

const depositForBurnEvent = [{
  type: 'event',
  name: 'DepositForBurn',
  inputs: [
    { indexed: true, name: 'nonce', type: 'uint64' },
    { indexed: true, name: 'burnToken', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: true, name: 'depositor', type: 'address' },
    { indexed: false, name: 'mintRecipient', type: 'bytes32' },
    { indexed: false, name: 'destinationDomain', type: 'uint32' },
    { indexed: false, name: 'destinationTokenMessenger', type: 'bytes32' },
    { indexed: false, name: 'destinationCaller', type: 'bytes32' },
    { indexed: false, name: 'maxFee', type: 'uint256' },
    { indexed: false, name: 'minFinalityThreshold', type: 'uint32' },
  ],
}]

// This service only needs the routes its API accepts. Keep their CCTP V2
// metadata explicit and reviewable instead of loading App Kit (and its
// browser/Solana dependency tree) at backend startup. The production domains,
// TokenMessenger addresses, USDC addresses, and explorer routes were checked
// against Circle's CCTP V2 and USDC contract-address references.
const CCTP_V2_MAINNET_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const CCTP_V2_TESTNET_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
// App Kit routes its existing custom-fee bridge through this verified bridge
// contract, which emits the same DepositForBurn event as the CCTP messenger.
// This is an analytics verification allowlist entry only; it does not affect
// Bridge Kit configuration or transaction execution.
const APP_KIT_MAINNET_BRIDGE_CONTRACT = '0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0'
const chainMetadata = [
  ['mainnet', 'Arc', 5042, 26, 'https://rpc.mainnet.arc.io/', 'https://explorer.arc.io/tx/{hash}', '0x3600000000000000000000000000000000000000'],
  ['mainnet', 'Arbitrum', 42161, 3, 'https://arb1.arbitrum.io/rpc', 'https://arbiscan.io/tx/{hash}', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
  ['mainnet', 'Avalanche', 43114, 1, 'https://api.avax.network/ext/bc/C/rpc', 'https://subnets.avax.network/c-chain/tx/{hash}', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'],
  ['mainnet', 'Base', 8453, 6, 'https://mainnet.base.org', 'https://basescan.org/tx/{hash}', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  ['mainnet', 'Codex', 81224, 12, 'https://rpc.codex.xyz', 'https://explorer.codex.xyz/tx/{hash}', '0xd996633a415985DBd7D6D12f4A4343E31f5037cf'],
  ['mainnet', 'Cronos', 25, 32, 'https://evm.cronos.org', 'https://cronoscan.com/tx/{hash}', '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D'],
  ['mainnet', 'Edge', 3343, 28, 'https://edge-mainnet.g.alchemy.com/public', 'https://pro.edgex.exchange/en-US/explorer/tx/{hash}', '0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c', '0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c'],
  ['mainnet', 'Ethereum', 1, 0, 'https://ethereum-rpc.publicnode.com', 'https://etherscan.io/tx/{hash}', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
  ['mainnet', 'HyperEVM', 999, 19, 'https://rpc.hyperliquid.xyz/evm', 'https://hyperevmscan.io/tx/{hash}', '0xb88339CB7199b77E23DB6E890353E22632Ba630f'],
  ['mainnet', 'Injective', 1776, 29, 'https://sentry.evm-rpc.injective.network', 'https://injscan.com/transaction/{hash}', '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a'],
  ['mainnet', 'Ink', 57073, 21, 'https://rpc-gel.inkonchain.com', 'https://explorer.inkonchain.com/tx/{hash}', '0x2D270e6886d130D724215A266106e6832161EAEd'],
  ['mainnet', 'Linea', 59144, 11, 'https://rpc.linea.build', 'https://lineascan.build/tx/{hash}', '0x176211869cA2b568f2A7D4EE941E073a821EE1ff'],
  ['mainnet', 'Monad', 143, 15, 'https://rpc.monad.xyz', 'https://monadscan.com/tx/{hash}', '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'],
  ['mainnet', 'Morph', 2818, 30, 'https://rpc.morphl2.io', 'https://explorer.morph.network/tx/{hash}', '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B'],
  ['mainnet', 'Optimism', 10, 2, 'https://mainnet.optimism.io', 'https://optimistic.etherscan.io/tx/{hash}', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
  ['mainnet', 'Pharos', 1672, 31, 'https://rpc.pharos.xyz', 'https://pharos.socialscan.io/tx/{hash}', '0xC879C018dB60520F4355C26eD1a6D572cdAC1815'],
  ['mainnet', 'Plasma', 9745, 33, 'https://rpc.plasma.to', 'https://plasmascan.to/tx/{hash}', '0x2d661C89D812261039AF9764eceaAee884f5F67F'],
  ['mainnet', 'Plume', 98866, 22, 'https://rpc.plume.org', 'https://explorer.plume.org/tx/{hash}', '0x222365EF19F7947e5484218551B56bb3965Aa7aF'],
  ['mainnet', 'Polygon', 137, 7, 'https://polygon.publicnode.com', 'https://polygonscan.com/tx/{hash}', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'],
  ['mainnet', 'Sei', 1329, 16, 'https://evm-rpc.sei-apis.com', 'https://seiscan.io/tx/{hash}', '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392'],
  ['mainnet', 'Sonic', 146, 13, 'https://rpc.soniclabs.com', 'https://sonicscan.org/tx/{hash}', '0x29219dd400f2Bf60E5a23d13Be72B486D4038894'],
  ['mainnet', 'Unichain', 130, 10, 'https://mainnet.unichain.org', 'https://unichain.blockscout.com/tx/{hash}', '0x078D782b760474a361dDA0AF3839290b0EF57AD6'],
  ['mainnet', 'World Chain', 480, 14, 'https://worldchain-mainnet.g.alchemy.com/public', 'https://worldscan.org/tx/{hash}', '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1'],
  ['mainnet', 'XDC', 50, 18, 'https://erpc.xdcrpc.com', 'https://xdcscan.io/tx/{hash}', '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1'],
  ['mainnet', 'X Layer', 196, 37, 'https://xlayerrpc.okx.com', 'https://www.oklink.com/xlayer/tx/{hash}', '0xB6CEceAB302E2E4948951eE7843FC24E92933061'],
  ['testnet', 'Arc_Testnet', 5042002, 26, 'https://rpc.testnet.arc.network/', 'https://testnet.arcscan.app/tx/{hash}', '0x3600000000000000000000000000000000000000'],
  ['testnet', 'Ethereum_Sepolia', 11155111, 0, 'https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.etherscan.io/tx/{hash}', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],
  ['testnet', 'Arbitrum_Sepolia', 421614, 3, 'https://sepolia-rollup.arbitrum.io/rpc', 'https://sepolia.arbiscan.io/tx/{hash}', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'],
  ['testnet', 'Base_Sepolia', 84532, 6, 'https://sepolia.base.org', 'https://sepolia.basescan.org/tx/{hash}', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
]

const supportedChains = chainMetadata.map(([environment, chain, chainId, domain, rpcUrl, explorerUrl, usdcAddress, tokenMessenger]) => ({
  environment,
  chain,
  chainId,
  usdcAddress,
  usdcDecimals: 6,
  rpcUrl,
  explorerUrl,
  cctp: { domain, tokenMessenger: tokenMessenger || (environment === 'mainnet' ? CCTP_V2_MAINNET_MESSENGER : CCTP_V2_TESTNET_MESSENGER) },
}))

function assertSupportedChainRegistry(chains) {
  const ids = new Set()
  const domains = new Set()
  for (const chain of chains) {
    const idKey = `${chain.environment}:${chain.chainId}`
    const domainKey = `${chain.environment}:${chain.cctp.domain}`
    if (!Number.isInteger(chain.chainId) || chain.chainId <= 0 || ids.has(idKey)) throw new Error(`Invalid or duplicate chain ID: ${idKey}`)
    if (!Number.isInteger(chain.cctp.domain) || chain.cctp.domain < 0 || domains.has(domainKey)) throw new Error(`Invalid or duplicate CCTP domain: ${domainKey}`)
    if (!ADDRESS_PATTERN.test(chain.usdcAddress) || !ADDRESS_PATTERN.test(chain.cctp.tokenMessenger)) throw new Error(`Invalid CCTP address configuration for ${chain.chain}`)
    if (!chain.rpcUrl.startsWith('https://') || !chain.explorerUrl.includes('{hash}')) throw new Error(`Invalid RPC or explorer configuration for ${chain.chain}`)
    ids.add(idKey)
    domains.add(domainKey)
  }
}

assertSupportedChainRegistry(supportedChains)

const chainsByEnvironmentAndId = new Map(supportedChains.map((chain) => [`${chain.environment}:${chain.chainId}`, chain]))
const chainsByEnvironmentAndName = new Map(supportedChains.map((chain) => [`${chain.environment}:${chain.chain}`, chain]))

function ensureDataFileDirectory() {
  fs.mkdirSync(dirname(DATA_FILE), { recursive: true })
}

function loadData() {
  ensureDataFileDirectory()
  if (!fs.existsSync(DATA_FILE)) return { bridges: [] }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
    return { bridges: Array.isArray(data.bridges) ? data.bridges.filter((bridge) => bridge && typeof bridge === 'object') : [] }
  } catch {
    return { bridges: [] }
  }
}

function saveData(data) {
  ensureDataFileDirectory()
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

function parseEnvironment(value, { allowLegacyTestnet = false } = {}) {
  if (value === undefined && allowLegacyTestnet) return 'testnet'
  return typeof value === 'string' && ENVIRONMENTS.has(value) ? value : null
}

function normalizeRecord(record) {
  const environment = record.environment === 'mainnet' ? 'mainnet' : 'testnet'
  const source = Number.isInteger(record.sourceChainId)
    ? chainsByEnvironmentAndId.get(`${environment}:${record.sourceChainId}`)
    : chainsByEnvironmentAndName.get(`${environment}:${record.sourceChain}`) || chainsByEnvironmentAndName.get(`${environment}:${record.chain}`)
  const destination = Number.isInteger(record.destinationChainId)
    ? chainsByEnvironmentAndId.get(`${environment}:${record.destinationChainId}`)
    : null

  return {
    ...record,
    environment,
    sourceChainId: source?.chainId ?? record.sourceChainId ?? null,
    destinationChainId: destination?.chainId ?? record.destinationChainId ?? null,
    sourceChain: source?.chain ?? record.sourceChain ?? record.chain ?? null,
    destinationChain: destination?.chain ?? record.destinationChain ?? null,
    amount: typeof record.amount === 'string' || typeof record.amount === 'number' ? record.amount : null,
    explorerUrl: source && HASH_PATTERN.test(record.txHash || '') ? source.explorerUrl.replace('{hash}', record.txHash) : null,
  }
}

function recordsForEnvironment(data, environment) {
  return data.bridges.map(normalizeRecord).filter((record) => record.environment === environment)
}

function analyticsResponse(data, environment) {
  const bridges = recordsForEnvironment(data, environment)
  const total = bridges.reduce((sum, bridge) => sum + Number(bridge.amount || 0), 0)
  const networkActivity = new Map()
  for (const bridge of bridges) {
    const key = bridge.sourceChainId ?? bridge.sourceChain ?? 'unknown'
    const current = networkActivity.get(key) || { chainId: bridge.sourceChainId, chain: bridge.sourceChain, count: 0, volume: 0 }
    current.count += 1
    current.volume += Number(bridge.amount || 0)
    networkActivity.set(key, current)
  }

  return {
    environment,
    total,
    count: bridges.length,
    average: bridges.length ? total / bridges.length : 0,
    networkActivity: [...networkActivity.values()],
    recentTransfers: [...bridges].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, 25),
  }
}

function resolveSourceChain(body, environment) {
  if (Number.isInteger(body.sourceChainId)) return chainsByEnvironmentAndId.get(`${environment}:${body.sourceChainId}`)
  // Legacy testnet clients submit Bridge Kit's chain name only.
  if (environment === 'testnet' && typeof body.chain === 'string') return chainsByEnvironmentAndName.get(`testnet:${body.chain}`)
  return undefined
}

export async function verifyBridge({ source, destinationChainId, txHash, client = createPublicClient({ transport: http(source.rpcUrl) }) }) {
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('Transaction was not successful on-chain')

  const verifiedEmitters = new Set([source.cctp.tokenMessenger.toLowerCase()])
  if (source.environment === 'mainnet') verifiedEmitters.add(APP_KIT_MAINNET_BRIDGE_CONTRACT.toLowerCase())
  const verifiedLog = receipt.logs.find((log) => {
    if (!verifiedEmitters.has(log.address.toLowerCase())) return false
    try {
      const decoded = decodeEventLog({ abi: depositForBurnEvent, data: log.data, topics: log.topics })
      return decoded.eventName === 'DepositForBurn'
    } catch {
      return false
    }
  })
  if (!verifiedLog) throw new Error('No CCTP DepositForBurn event was found for the configured source route')

  const { args } = decodeEventLog({ abi: depositForBurnEvent, data: verifiedLog.data, topics: verifiedLog.topics })
  if (args.burnToken.toLowerCase() !== source.usdcAddress.toLowerCase()) throw new Error('CCTP event did not burn the configured source USDC')
  const destination = supportedChains.find((chain) => chain.environment === source.environment && chain.cctp.domain === args.destinationDomain)
  if (!destination) throw new Error('CCTP event destination is not a supported route in this environment')
  if (destinationChainId !== undefined && destinationChainId !== destination.chainId) throw new Error('Submitted destination chain does not match the verified CCTP event')
  if (args.destinationTokenMessenger.toLowerCase() !== padHex(destination.cctp.tokenMessenger, { size: 32 }).toLowerCase()) {
    throw new Error('CCTP event destination messenger does not match the verified destination route')
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  return {
    source,
    destination,
    amount: formatUnits(args.amount, source.usdcDecimals),
    amountAtomic: args.amount.toString(),
    timestamp: Number(block.timestamp) * 1000,
  }
}

// Kept outside the route so API tests can exercise persistence and analytics
// without making a blockchain request. Production always uses verifyBridge.
let bridgeVerifier = verifyBridge
export function setBridgeVerifierForTests(verifier) {
  bridgeVerifier = verifier
}

// Record a verified source-chain CCTP burn. Client-provided amounts are ignored.
app.post('/api/bridges', async (req, res) => {
  const environment = parseEnvironment(req.body?.environment, { allowLegacyTestnet: true })
  if (!environment) return res.status(400).json({ error: 'Invalid environment' })
  const txHash = req.body?.txHash
  if (typeof txHash !== 'string' || !HASH_PATTERN.test(txHash)) return res.status(400).json({ error: 'Invalid transaction hash' })

  const source = resolveSourceChain(req.body, environment)
  if (!source) return res.status(400).json({ error: 'Unknown source chain for environment' })
  const destinationChainId = req.body?.destinationChainId
  if (environment === 'mainnet' && !Number.isInteger(destinationChainId)) return res.status(400).json({ error: 'Mainnet destinationChainId is required' })

  const data = loadData()
  if (recordsForEnvironment(data, environment).some((bridge) => bridge.txHash?.toLowerCase() === txHash.toLowerCase())) {
    return res.json({ ok: true, duplicate: true, ...analyticsResponse(data, environment) })
  }

  try {
    const verified = await bridgeVerifier({ source, destinationChainId, txHash })
    data.bridges.push({
      environment,
      sourceChainId: verified.source.chainId,
      destinationChainId: verified.destination.chainId,
      sourceChain: verified.source.chain,
      destinationChain: verified.destination.chain,
      amount: verified.amount,
      amountAtomic: verified.amountAtomic,
      txHash,
      timestamp: verified.timestamp,
    })
    saveData(data)
    return res.json({ ok: true, duplicate: false, ...analyticsResponse(data, environment) })
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not verify transaction on-chain' })
  }
})

// Reads default to the legacy testnet namespace; mainnet is always explicit.
app.get('/api/volume', (req, res) => {
  const environment = parseEnvironment(req.query.environment, { allowLegacyTestnet: true })
  if (!environment) return res.status(400).json({ error: 'Invalid environment' })
  const data = loadData()
  res.json(analyticsResponse(data, environment))
})

const PORT = process.env.PORT || 3001
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  app.listen(PORT, () => console.log(`ArcBridge backend running on port ${PORT}`))
}

export { app, assertSupportedChainRegistry, supportedChains }
