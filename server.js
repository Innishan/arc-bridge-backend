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
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MICRO_POINTS_PER_POINT = 1_000_000n
const MAX_POINTS_MICRO = 1_000_000n * MICRO_POINTS_PER_POINT
const REFERRAL_POINTS_MICRO = 50n * MICRO_POINTS_PER_POINT
const APP_KIT_BRIDGE_CONTRACT = '0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0'.toLowerCase()

const depositForBurnEvent = [{
  type: 'event',
  name: 'DepositForBurn',
  inputs: [
    { indexed: true, name: 'burnToken', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: true, name: 'depositor', type: 'address' },
    { indexed: false, name: 'mintRecipient', type: 'bytes32' },
    { indexed: false, name: 'destinationDomain', type: 'uint32' },
    { indexed: false, name: 'destinationTokenMessenger', type: 'bytes32' },
    { indexed: false, name: 'destinationCaller', type: 'bytes32' },
    { indexed: false, name: 'maxFee', type: 'uint256' },
    { indexed: true, name: 'minFinalityThreshold', type: 'uint32' },
    { indexed: false, name: 'hookData', type: 'bytes' },
  ],
}]

const feePaidEvent = [{
  type: 'event',
  name: 'FeePaid',
  inputs: [
    { indexed: true, name: 'user', type: 'address' },
    { indexed: true, name: 'token', type: 'address' },
    { indexed: false, name: 'amountBridged', type: 'uint256' },
    { indexed: false, name: 'totalFee', type: 'uint256' },
    { indexed: false, name: 'feeAmount', type: 'uint256' },
    { indexed: true, name: 'feeRecipient', type: 'address' },
  ],
}]

// This service only needs the routes its API accepts. Keep their CCTP V2
// metadata explicit and reviewable instead of loading App Kit (and its
// browser/Solana dependency tree) at backend startup. The production domains,
// TokenMessenger addresses, USDC addresses, and explorer routes were checked
// against Circle's CCTP V2 and USDC contract-address references.
const CCTP_V2_MAINNET_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const CCTP_V2_TESTNET_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
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
    return {
      ...data,
      bridges: Array.isArray(data.bridges) ? data.bridges.filter((bridge) => bridge && typeof bridge === 'object') : [],
    }
  } catch {
    return { bridges: [] }
  }
}

function saveData(data) {
  ensureDataFileDirectory()
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

const validMicroPoints = (value) => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n
const pointsNumber = (microPoints) => Number(microPoints) / Number(MICRO_POINTS_PER_POINT)
const normalizedAddress = (value) => typeof value === 'string' && ADDRESS_PATTERN.test(value) ? value.toLowerCase() : null

function pointsState(data) {
  if (!data.points || typeof data.points !== 'object') data.points = {}
  const points = data.points
  points.maxPoints = 1_000_000
  points.totalDistributedMicro = validMicroPoints(points.totalDistributedMicro).toString()
  points.totalDistributed = pointsNumber(validMicroPoints(points.totalDistributedMicro))
  points.programComplete = validMicroPoints(points.totalDistributedMicro) >= MAX_POINTS_MICRO
  if (!points.users || typeof points.users !== 'object') points.users = {}
  if (!points.referrals || typeof points.referrals !== 'object') points.referrals = {}
  if (!Array.isArray(points.ledger)) points.ledger = []
  return points
}

function pointsUser(points, address) {
  if (!points.users[address]) {
    points.users[address] = { address, pointsMicro: '0', bridgePointsMicro: '0', referralPointsMicro: '0', successfulReferrals: 0 }
  }
  return points.users[address]
}

function awardPoints(points, user, type, requestedMicro, entry) {
  const distributed = validMicroPoints(points.totalDistributedMicro)
  const awarded = requestedMicro > MAX_POINTS_MICRO - distributed ? MAX_POINTS_MICRO - distributed : requestedMicro
  if (awarded <= 0n) return 0n
  user.pointsMicro = (validMicroPoints(user.pointsMicro) + awarded).toString()
  const category = type === 'bridge' ? 'bridgePointsMicro' : 'referralPointsMicro'
  user[category] = (validMicroPoints(user[category]) + awarded).toString()
  points.totalDistributedMicro = (distributed + awarded).toString()
  points.totalDistributed = pointsNumber(distributed + awarded)
  points.programComplete = distributed + awarded >= MAX_POINTS_MICRO
  points.ledger.push({ ...entry, type, pointsMicro: awarded.toString(), points: pointsNumber(awarded) })
  return awarded
}

// This is intentionally not invoked by request handling. A production
// reconciliation must first identify the exact affected bridge ledger entries
// from a production data export, then call this once with those transaction
// hashes. It moves existing bridge attribution in place, preserving the
// original reward entry, transaction hash, amount, timestamp, and global cap.
export function reconcileBridgePointAttribution(data, { from, to, txHashes }) {
  const oldWallet = normalizedAddress(from)
  const newWallet = normalizedAddress(to)
  if (!oldWallet || !newWallet || oldWallet === newWallet) throw new Error('Valid distinct reconciliation wallets are required')
  if (!Array.isArray(txHashes) || txHashes.length === 0 || txHashes.some((hash) => typeof hash !== 'string' || !HASH_PATTERN.test(hash))) {
    throw new Error('At least one valid transaction hash is required for reconciliation')
  }

  const requested = new Set(txHashes.map((hash) => hash.toLowerCase()))
  const points = pointsState(data)
  const entries = points.ledger.filter((entry) => entry?.type === 'bridge' && requested.has(entry.txHash?.toLowerCase()))
  if (entries.length !== requested.size) throw new Error('Every requested transaction must have exactly one bridge ledger entry')
  if (new Set(entries.map((entry) => entry.txHash.toLowerCase())).size !== entries.length) throw new Error('Bridge ledger contains duplicate reconciliation entries')

  const alreadyReconciled = entries.every((entry) => entry.wallet?.toLowerCase() === newWallet && entry.attributionCorrection?.from === oldWallet && entry.attributionCorrection?.to === newWallet)
  if (alreadyReconciled) return { movedMicro: '0', reconciled: false }
  if (entries.some((entry) => entry.wallet?.toLowerCase() !== oldWallet)) throw new Error('Bridge ledger entry does not have the expected incorrect attribution')
  const oldUser = points.users[oldWallet]
  if (!oldUser) throw new Error('Incorrectly attributed points user was not found')

  const bridgeByHash = new Map(data.bridges.map((bridge) => [bridge.txHash?.toLowerCase(), bridge]))
  for (const entry of entries) {
    const bridge = bridgeByHash.get(entry.txHash.toLowerCase())
    if (!bridge || bridge.environment !== 'mainnet' || bridge.depositor?.toLowerCase() !== oldWallet) throw new Error('Bridge record does not match the incorrect attribution')
    if (bridge.user && bridge.user.toLowerCase() !== newWallet) throw new Error('Bridge record already belongs to a different verified user')
    if (String(bridge.amountAtomic) !== String(entry.amountAtomic)) throw new Error('Bridge amount does not match its ledger entry')
  }

  const moved = entries.reduce((total, entry) => total + validMicroPoints(entry.pointsMicro), 0n)
  if (moved === 0n) return { movedMicro: '0', reconciled: false }
  if (validMicroPoints(oldUser.bridgePointsMicro) < moved || validMicroPoints(oldUser.pointsMicro) < moved) throw new Error('Incorrect user balance cannot cover the reconciled bridge entries')

  const newUser = pointsUser(points, newWallet)
  oldUser.pointsMicro = (validMicroPoints(oldUser.pointsMicro) - moved).toString()
  oldUser.bridgePointsMicro = (validMicroPoints(oldUser.bridgePointsMicro) - moved).toString()
  newUser.pointsMicro = (validMicroPoints(newUser.pointsMicro) + moved).toString()
  newUser.bridgePointsMicro = (validMicroPoints(newUser.bridgePointsMicro) + moved).toString()
  for (const entry of entries) {
    entry.wallet = newWallet
    entry.attributionCorrection = { from: oldWallet, to: newWallet, correctedAt: entry.timestamp }
    bridgeByHash.get(entry.txHash.toLowerCase()).user = newWallet
  }
  return { movedMicro: moved.toString(), reconciled: true }
}

function pointsResponse(points, address) {
  const user = points.users[address] || { address, pointsMicro: '0', bridgePointsMicro: '0', referralPointsMicro: '0', successfulReferrals: 0 }
  const distributed = validMicroPoints(points.totalDistributedMicro)
  return {
    address,
    points: pointsNumber(validMicroPoints(user.pointsMicro)),
    walletPoints: pointsNumber(validMicroPoints(user.pointsMicro)),
    bridgePoints: pointsNumber(validMicroPoints(user.bridgePointsMicro)),
    referralPoints: pointsNumber(validMicroPoints(user.referralPointsMicro)),
    successfulReferrals: user.successfulReferrals || 0,
    totalDistributed: pointsNumber(distributed),
    remaining: pointsNumber(MAX_POINTS_MICRO - distributed),
    maxPoints: 1_000_000,
    programComplete: distributed >= MAX_POINTS_MICRO,
  }
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

  const tokenMessenger = source.cctp.tokenMessenger.toLowerCase()
  const verifiedLog = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== tokenMessenger) return false
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

  const transaction = await client.getTransaction({ hash: txHash })
  const transactionFrom = normalizedAddress(transaction?.from)
  if (!transactionFrom) throw new Error('Source transaction did not contain a valid sender')

  // App Kit submits the CCTP burn itself. Its depositor is therefore the App
  // Kit contract, not the user entitled to points. For this one flow require
  // the companion FeePaid event to bind the canonical burn to transaction.from.
  if (source.environment === 'mainnet' && args.depositor.toLowerCase() === APP_KIT_BRIDGE_CONTRACT) {
    const feePaidLogs = receipt.logs.flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: feePaidEvent, data: log.data, topics: log.topics })
        return decoded.eventName === 'FeePaid' ? [{ log, args: decoded.args }] : []
      } catch {
        return []
      }
    })
    if (feePaidLogs.some(({ log }) => log.address.toLowerCase() !== APP_KIT_BRIDGE_CONTRACT)) throw new Error('App Kit FeePaid event was emitted by an unexpected contract')
    if (feePaidLogs.length !== 1) throw new Error('App Kit bridge attribution requires exactly one valid FeePaid event from the App Kit bridge contract')
    const feePaid = feePaidLogs[0].args
    if (feePaid.user.toLowerCase() !== transactionFrom) throw new Error('App Kit FeePaid user does not match the source transaction sender')
    if (feePaid.token.toLowerCase() !== source.usdcAddress.toLowerCase()) throw new Error('App Kit FeePaid token does not match the configured source USDC')
    if (feePaid.amountBridged !== args.amount) throw new Error('App Kit FeePaid amount does not match the verified CCTP amount')
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  return {
    source,
    destination,
    depositor: args.depositor.toLowerCase(),
    user: transactionFrom,
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

  let data = loadData()
  if (recordsForEnvironment(data, environment).some((bridge) => bridge.txHash?.toLowerCase() === txHash.toLowerCase())) {
    const points = pointsState(data)
    const existing = recordsForEnvironment(data, environment).find((bridge) => bridge.txHash?.toLowerCase() === txHash.toLowerCase())
    return res.json({ ok: true, duplicate: true, ...analyticsResponse(data, environment), points: existing?.user ? { ...pointsResponse(points, existing.user), awarded: 0, referralAwarded: false } : undefined })
  }

  try {
    const verified = await bridgeVerifier({ source, destinationChainId, txHash })
    // Load after async verification so every persisted update starts from the
    // latest JSON state and duplicate submissions cannot award points twice.
    data = loadData()
    if (recordsForEnvironment(data, environment).some((bridge) => bridge.txHash?.toLowerCase() === txHash.toLowerCase())) {
      const points = pointsState(data)
      const existing = recordsForEnvironment(data, environment).find((bridge) => bridge.txHash?.toLowerCase() === txHash.toLowerCase())
      return res.json({ ok: true, duplicate: true, ...analyticsResponse(data, environment), points: existing?.user ? { ...pointsResponse(points, existing.user), awarded: 0, referralAwarded: false } : undefined })
    }
    data.bridges.push({
      environment,
      sourceChainId: verified.source.chainId,
      destinationChainId: verified.destination.chainId,
      sourceChain: verified.source.chain,
      destinationChain: verified.destination.chain,
      amount: verified.amount,
      amountAtomic: verified.amountAtomic,
      ...(verified.depositor ? { depositor: verified.depositor } : {}),
      ...(verified.user ? { user: verified.user } : {}),
      txHash,
      timestamp: verified.timestamp,
    })
    let pointsResult
    if (environment === 'mainnet' && verified.user) {
      const points = pointsState(data)
      const wallet = verified.user.toLowerCase()
      const user = pointsUser(points, wallet)
      const bridgeAward = awardPoints(points, user, 'bridge', BigInt(verified.amountAtomic), {
        wallet, txHash, amountAtomic: verified.amountAtomic, timestamp: verified.timestamp,
      })
      let referralAward = 0n
      const referral = points.referrals[wallet]
      const firstVerifiedBridge = !data.bridges.slice(0, -1).some((bridge) => bridge.environment === 'mainnet' && bridge.user?.toLowerCase() === wallet)
      if (firstVerifiedBridge && referral && !referral.rewarded) {
        const referrer = pointsUser(points, referral.referrer)
        referralAward = awardPoints(points, referrer, 'referral', REFERRAL_POINTS_MICRO, {
          wallet, referrer: referral.referrer, txHash, timestamp: verified.timestamp,
        })
        if (referralAward > 0n) {
          referral.rewarded = true
          referral.rewardedAt = verified.timestamp
          referrer.successfulReferrals += 1
        }
      }
      pointsResult = {
        ...pointsResponse(points, wallet),
        awarded: pointsNumber(bridgeAward),
        referralAwarded: referralAward > 0n,
        programComplete: points.programComplete,
      }
    }
    saveData(data)
    return res.json({ ok: true, duplicate: false, ...analyticsResponse(data, environment), ...(pointsResult ? { points: pointsResult } : {}) })
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not verify transaction on-chain' })
  }
})

app.get('/api/points', (req, res) => {
  const address = normalizedAddress(req.query.address)
  if (!address || address === ZERO_ADDRESS) return res.status(400).json({ error: 'Valid wallet address is required' })
  const data = loadData()
  const points = pointsState(data)
  res.json({ ok: true, ...pointsResponse(points, address) })
})

app.post('/api/referrals', (req, res) => {
  const referrer = normalizedAddress(req.body?.referrer)
  const referred = normalizedAddress(req.body?.referred)
  if (!referrer || !referred || referrer === ZERO_ADDRESS || referred === ZERO_ADDRESS) return res.status(400).json({ error: 'Valid non-zero wallet addresses are required' })
  if (referrer === referred) return res.status(400).json({ error: 'Self-referral is not allowed' })
  const data = loadData()
  const points = pointsState(data)
  const existing = points.referrals[referred]
  if (existing) return res.status(409).json({ error: 'Referral relationship is already established', referral: existing })
  const referral = { referrer, createdAt: Date.now(), rewarded: false, rewardedAt: null }
  points.referrals[referred] = referral
  saveData(data)
  res.json({ ok: true, referred, referral })
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
