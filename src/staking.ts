import { Account, AccountInfo, Connection, PublicKey, TokenAccountBalancePair } from '@solana/web3.js'
import { AccountsCoder, BN } from '@project-serum/anchor'
import { AssetsList, Exchange, ExchangeAccount, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { liquidate, getAccountsAtRisk, createAccountsOnAllCollaterals, isLiquidatable, UserWithAddress, U64_MAX } from './utils'
import { blue, cyan } from 'colors'
import { Prices } from './prices'
import { Idl } from '@project-serum/anchor'
import { Synchronizer } from './synchronizer'
import { parseUser } from './fetchers'
import { IDL } from '@synthetify/sdk/lib/idl/exchange'
import { connect } from 'http2'
import { interval, Observable, throttle } from 'rxjs'
import { Price } from '@pythnetwork/client'

interface checkAccountsParams {
  exchange: Exchange
  state: ExchangeState
  prices: Prices
  connection: Connection
  collateralAccounts: PublicKey[]
  xUSDAccount: any
  wallet: Account
  xUSDToken: Token
}

const synchronizers = new Map<PublicKey, Synchronizer<ExchangeAccount>>()

const checkAccounts = async (params: checkAccountsParams) => {

  let { prices, collateralAccounts, connection, exchange, state, wallet, xUSDAccount, xUSDToken } = params

  let atRisk: UserWithAddress[] = []

  synchronizers.forEach((synchonizer, key) => {
    const liquidatable = isLiquidatable(state, prices.assetsList, synchonizer.account)
    if (liquidatable)
      atRisk.push({ address: key, data: synchonizer.account })
  })

  console.log('Done scanning accounts')

  console.log(cyan(`Running check on liquidatable accounts..`))

  for (let user of atRisk) {
    if (user.data.liquidationDeadline.eq(U64_MAX)) {
      await exchange.checkAccount(user.address)
      user = { address: user.address, data: await exchange.getExchangeAccount(user.address) }
    }
  }

  console.log(blue(`Found: ${atRisk.length} accounts at risk`))


  atRisk = atRisk.sort((a, b) => a.data.liquidationDeadline.cmp(b.data.liquidationDeadline))
  const slot = new BN(await connection.getSlot())

  console.log(cyan(`Liquidating suitable accounts (${atRisk.length})..`))

  for (const exchangeAccount of atRisk) {
    // Users are sorted so we can stop checking if deadline is in the future

    const accountFresh = synchronizers.get(exchangeAccount.address) as Synchronizer<ExchangeAccount>
    if (slot.lt(accountFresh.account.liquidationDeadline)) break
    while (true) {
      const liquidated = await liquidate(
        exchange,
        accountFresh,
        prices.assetsList,
        state,
        collateralAccounts,
        wallet,
        xUSDAccount.amount,
        xUSDAccount.address
      )
      if (!liquidated) break
      xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    }
  }
}


export const stakingLoop = async (exchange: Exchange, wallet: Account) => {
  const { connection, programId: exchangeProgram } = exchange
  const coder = new AccountsCoder(IDL as Idl)
  let checking = false

  const state = new Synchronizer<ExchangeState>(
    connection,
    exchange.stateAddress,
    'state',
    await exchange.getState()
  )


  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1420 }]
  })



  accounts.forEach((data) => {
    const account = parseUser(data.account, coder)
    synchronizers.set(data.pubkey, new Synchronizer<ExchangeAccount>(connection, data.pubkey, 'exchangeAccount', account))
  })

  const prices = await Prices.build(
    connection,
    await exchange.getAssetsList(state.account.assetsList)
  )
  const priceObservalbe = new Observable(observer => prices.onChange(() => observer.next())).pipe(throttle(_ => interval(50)))

  const collateralAccounts = await createAccountsOnAllCollaterals(
    wallet,
    connection,
    prices.assetsList
  )
  const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  let xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)


  priceObservalbe.subscribe(async () => {
    if (!checking) {
      checking = true
      const params: checkAccountsParams = {
        exchange,
        state: state.account,
        prices: prices,
        connection,
        collateralAccounts,
        xUSDAccount,
        xUSDToken,
        wallet
      }
      await checkAccounts(params)
      checking = false
    }
  })




}
