import { Account, Keypair } from '@solana/web3.js'
import { Provider, Wallet } from '@project-serum/anchor'
import { Network } from '@synthetify/sdk/lib/network'
import { Exchange } from '@synthetify/sdk/lib/exchange'
import { sleep } from '@synthetify/sdk/lib/utils'
import { getConnection } from './utils'
import { stakingLoop } from './staking'
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes'

const NETWORK = Network.MAIN
const SCAN_INTERVAL = 1000 * 60 * 5

const secretWallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process?.env?.PRIV_KEY ?? '')))


const connection = getConnection(NETWORK)
const provider = new Provider(connection, secretWallet, { commitment: 'recent' })

// @ts-expect-error
const wallet = provider.wallet.payer as Account

const main = async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(connection, NETWORK, provider.wallet)
  await exchange.getState()

  console.log(`Using wallet: ${wallet.publicKey}`)

  await stakingLoop(exchange, wallet)
}

main()
