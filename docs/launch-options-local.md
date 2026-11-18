The token launcher still starts from a saved inscription. It creates a separate coin and retains the source link. No NFT migration or fractionalization is involved.

- Solana: native SOL remains the default. Pump's SDK builds the selected quote mint, optional atomic opening buy and supported launch mode. The buy uses Pump's smaller v3 exact-input instruction. The app resolves the mint's token program and decimals, caps the opening buy at the entered amount and simulates the transaction before asking the wallet to sign. An opening buy that does not fit in one transaction stops before signing. [Pump pair list](https://pump.fun/docs/custom-pairs) · [Pump create instructions](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)
- Robinhood: native ETH remains the default. The factory must accept the selected quote asset and configuration. The transaction commits to the factory's quoted economics, uses its current ETH fee and is simulated with the selected options. The website field stays reserved for the inscription link. [Pons launch docs](https://docs.ponsfamily.com/v2#choosing-a-quote-asset) · [Robinhood token registry](https://docs.robinhood.com/chain/contracts/)

Pump's Creator fee sharing mode accepts Solana wallets and verified GitHub accounts or organizations. Shares total 100% and become locked at launch. GitHub is resolved to a numeric account ID for Pump's social fee account. The project X link is token metadata. Creation and the final fee split are submitted atomically. The local launch builder can encode a tokenized-agent instruction, but the form disables that mode while Pump's current program rejects initialization.

Pons uses the official launch-and-buy router when the buy amount is positive. The form requires a minimum output. ETH pairs include the buy amount in transaction value. ERC-20 pairs check the wallet's balance and allowance and request an exact-amount approval only when necessary. A confirmed allowance can remain if the creator cancels the next prompt or the launch fails. Pons still handles the no-buy path through its factory.

Before live use, verify the current Pump account lookup table and packet size for each chosen combination, the wallet/CDN imports, and the live Pons router with the intended asset. The local checks use venue fixtures and do not establish live execution. Pump's deprecated cashback mode and post-launch fee management are outside this launch form.

Offline tests: from the checkout run `npm install --no-save --package-lock=false @pump-fun/pump-sdk@4.1.0 @pump-fun/agent-payments-sdk@3.0.3 @solana/web3.js@1.99.0 bn.js@5.2.2 ethers@6.17.0`, then `node --test tests/launch-options.mjs`. The tests use the actual Pump SDK and ethers encoder with fixture RPC/wallet boundaries. They check stock-account wiring, integer quote amounts, the atomic-buy size guard, simulation-before-signing, fee-sharing and agent initialization data, Pons terms and unsupported-pair rejection, and ETH versus ERC-20 opening buys. No wallet, transaction or upload was sent to a public service.

### November 16 stock-pair rehearsal

The saved-inscription path in the token board used generated wallets and local fixtures for inscription inventory, metadata and feed writes. Solana transactions went to Surfpool. Robinhood approvals and launches went to an Anvil fork with a locally funded test wallet. Anvil obtained upstream state through a read-only proxy.

Pump fee sharing and a 0.125 NVDAx opening buy executed atomically on Surfpool after the wallet created a lookup table. The stock-denominated creator vault token account is initialized in the launch transaction. The lookup table setup is a separate wallet approval. The table is wallet-owned and its rent stays with that account until it is closed after deactivation.

The agent opening-buy transaction fit after lookup-table setup and reached the deployed program through SDK 3.0.3. The program rejected the initialization with error 6015, AgentInitializationNotSupported. Zo's UI disables agent creation before it can request setup or a launch signature.

Pons's deployed router executed an opening buy with a pasted NVDA contract in the local fork. The test wallet spent 0.125 NVDA, received the launched token and had zero remaining opening-buy allowance. Real wallet extensions, the public CDN and public inscription services remain outside this rehearsal.

Pair selection follows venue rules. Pump supports its listed assets and eligible Pump coin mints. Pons checks the current factory allowlist. Both forms accept additional addresses through the custom pair field.
