import assert from "node:assert/strict";
import { test, mock } from "node:test";
import BN from "bn.js";
import { AddressLookupTableAccount, Keypair, PublicKey } from "@solana/web3.js";
import { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda } from "@pump-fun/pump-sdk";
import { PROGRAM_ID as AGENT_PROGRAM, getOfflineProgram } from "@pump-fun/agent-payments-sdk";
import { Interface, getAddress, ZeroAddress } from "ethers";
import { preparePump, launchOnPump } from "../src/chain/launch/pumpfun.js";
import { launchOnPons, FACTORY, LAUNCH_AND_BUY } from "../src/chain/launch/pons.js";
import { PAIRS, SOL_MINT, USDC_MINT, canSetHolderRewardRate } from "../src/chain/launch/options.js";
const user = Keypair.generate().publicKey;
const stock = PAIRS.solana[2][1];

test("Pump builds SOL and Token-2022 stock instructions and verifies simulation before signing", async () => {
  const tokenProgram = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  mock.method(OnlinePumpSdk.prototype, "fetchGlobal", async () => ({ isHolderRewardEnabled: true, mayhemModeEnabled: true, creatorFeeConfigurable: true, maxConfigurableCreatorFeeBps: new BN(300) }));
  mock.method(OnlinePumpSdk.prototype, "resolveQuoteMint", async (mint) => {
    assert.ok([stock, USDC_MINT].includes(mint.toBase58()));
    return { decimals: 8, quoteTokenProgram: tokenProgram };
  });
  let transaction, table, signatures = 0, reject = false;
  const connection = {
    getAddressLookupTable: async () => ({ value: table }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async (tx) => { transaction = tx; return { value: { err: reject ? { fixture: "rejected" } : null } }; },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  const wallet = { publicKey: user, signAndSendTransaction: async () => { signatures++; return { signature: "fixture" }; } };
  for (const pair of ["", stock]) {
    const terms = await preparePump(connection, { pair, initialBuy: "0", mode: "holders" });
    const opts = { connection, wallet, name: "Fixture", symbol: "FIX", uri: "https://example.test/metadata", terms, onStep() {} };
    await launchOnPump(opts);
    const ix = transaction.message.compiledInstructions[1];
    const accounts = ix.accountKeyIndexes.map(i => transaction.message.staticAccountKeys[i].toBase58());
    assert.equal(accounts.length, pair ? 20 : 16);
    if (pair) {
      assert.equal(accounts[16], stock);
      assert.equal(accounts[18], tokenProgram.toBase58());
    }
    assert.equal(ix.data.at(-1), 1);
    reject = true;
    await assert.rejects(launchOnPump(opts), /simulation failed/);
    reject = false;
  }
  assert.equal(canSetHolderRewardRate("holders", stock), true);
  const holderTerms = await preparePump(connection, { pair: stock, mode: "holders", creatorFee: "100" });
  assert.equal(holderTerms.creatorFeeBps.toNumber(), 100);
  for (const mode of ["standard", "sharing", "mayhem"]) {
    assert.equal(canSetHolderRewardRate(mode, stock), false);
    if (mode !== "mayhem") {
      await assert.rejects(preparePump(connection, { pair: stock, mode, creatorFee: "100" }), /unavailable/);
    }
  }
  for (const pair of ["", SOL_MINT, USDC_MINT, PublicKey.default.toBase58()]) {
    assert.equal(canSetHolderRewardRate("holders", pair), false);
    await assert.rejects(preparePump(connection, { pair, mode: "holders", creatorFee: "100" }), /unavailable/);
  }
  await assert.rejects(preparePump(connection, { pair: stock, mode: "holders", creatorFee: "301" }), /up to 300 bps/);
  await assert.rejects(preparePump(connection, { pair: stock, mode: "holders", creatorFee: "-1" }), /whole basis points/);
  assert.equal(signatures, 2);
  await assert.rejects(preparePump(connection, { pair: stock, mode: "mayhem" }), /Mayhem is unavailable/);
  await assert.rejects(preparePump(connection, { pair: stock, mode: "standard", initialBuy: "0.000000001" }), /too many decimal/);
  const n = (value) => new BN(value);
  OnlinePumpSdk.prototype.fetchGlobal.mock.mockImplementation(async () => ({
    isHolderRewardEnabled: true, feeRecipient: user, feeRecipients: [], buybackBasisPoints: n(1000),
    initialVirtualTokenReserves: n("1073000000000000"), initialRealTokenReserves: n("793100000000000"),
    tokenTotalSupply: n("1000000000000000"), initialVirtualSolReserves: n("30000000000"),
    initialVirtualQuoteReserves: n("30000000000"), whitelistedQuoteMints: [new PublicKey(stock)],
    feeBasisPoints: n(100), creatorFeeBasisPoints: n(50),
  }));
  mock.method(OnlinePumpSdk.prototype, "fetchQuoteControl", async () => null);
  mock.method(OnlinePumpSdk.prototype, "fetchFeeConfig", async () => ({
    exoticFlatFees: { lpFeeBps: n(0), protocolFeeBps: n(100), creatorFeeBps: n(50) },
  }));
  const terms = await preparePump(connection, { pair: stock, mode: "holders", initialBuy: "0.125", creator: user });
  assert.equal(terms.quoteAmount.toString(), "12500000");
  assert.ok(terms.amount.gtn(0));
  const opening = { connection, wallet, name: "Fixture", symbol: "FIX", uri: "https://example.test/metadata", terms, onStep() {} };
  const params = { ...terms, mint: Keypair.generate().publicKey, name: opening.name, symbol: opening.symbol,
    uri: opening.uri, user, creator: user, slippage: 0 };
  const ix = [
    await PUMP_SDK.createV2Instruction(params),
    ...await PUMP_SDK.buyExactQuoteInV3Instructions({ ...params, associatedUserAccountInfo: null }),
  ];
  const addresses = [...new Map(ix.flatMap(i => i.keys.filter(k => !k.isSigner).map(k => [k.pubkey.toBase58(), k.pubkey]))).values()];
  table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: {
    deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses,
  } });
  await launchOnPump(opening);
  assert.equal(transaction.message.compiledInstructions.length, 6);
  assert.ok(transaction.serialize().length <= 1232);
  const buy = transaction.message.compiledInstructions.at(-2);
  assert.equal(Buffer.from(buy.data).readBigUInt64LE(8), 12500000n);
  const feeShares = user.toBase58() + " 6000\n" + Keypair.generate().publicKey.toBase58() + " 4000";
  await assert.rejects(preparePump(connection, { pair: stock, mode: "sharing", feeShares: user.toBase58() + " 9000" }), /10,000/);
  await assert.rejects(preparePump(connection, { pair: stock, mode: "agent", agentBuyback: "10001" }), /buyback rate/);

  for (const opts of [{ mode: "sharing", feeShares }, { mode: "agent", agentBuyback: "2750", initialBuy: "0.125" }]) {
    const terms = await preparePump(connection, { pair: stock, initialBuy: "0", creator: user, ...opts });
    const result = await launchOnPump({ ...opening, terms });
    const mint = new PublicKey(result.mint);
    const allKeys = transaction.message.getAccountKeys({ addressLookupTableAccounts: [table] });
    assert.ok(transaction.serialize().length <= 1232);
    const venueInstructions = transaction.message.compiledInstructions.slice(2, opts.initialBuy ? -4 : -1);
    if (opts.mode === "sharing") {
      assert.equal(venueInstructions.length, 3);
      const accounts = venueInstructions.map((ix) => ix.accountKeyIndexes.map((index) => allKeys.get(index).toBase58()));
      assert.ok([accounts[0],accounts[2]].every((keys) => keys.includes(feeSharingConfigPda(mint).toBase58())));
      assert.ok(accounts[2].includes(stock));
      assert.ok(accounts[2].includes(tokenProgram.toBase58()));
      const encoded = Buffer.from(venueInstructions[2].data);
      assert.equal(encoded.readUInt32LE(8), 2);
      assert.equal(encoded.readUInt16LE(44), 6000);
      assert.equal(encoded.readUInt16LE(78), 4000);
    } else {
      assert.equal(venueInstructions.length, 1);
      const instruction = venueInstructions[0];
      assert.ok(allKeys.get(instruction.programIdIndex).equals(AGENT_PROGRAM));
      assert.ok(instruction.accountKeyIndexes.some((index) => allKeys.get(index).equals(mint)));
      const decoded = getOfflineProgram().coder.instruction.decode(Buffer.from(instruction.data));
      assert.equal(decoded.data.buybackBps, 2750);
      assert.ok(decoded.data.authority.equals(user));
    }
  }
  mock.restoreAll();
});

const abi = new Interface([
  "function launchConfigCount() returns (uint256)",
  "function getLaunchConfig(uint256) returns ((uint256,uint256,uint256,uint256,uint24,int24,bool))",
  "function launchFee() returns (uint256)",
  "function canLaunch(address) returns (bool)",
  "function maxCreatorTaxBps() returns (uint16)",
  "function approvedPairTokens(address) returns (bool)",
  "function pairTokenEconomics(address) returns (uint256,uint256,uint8)",
  "function previewLaunchEconomics(uint256,address) returns (bytes32)",
  "function balanceOf(address) returns (uint256)",
  "function allowance(address,address) returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[]) returns (address,address,uint256)",
  "function launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[]) returns (address,address)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
]);
test("Pons pins economics and pair and rejects unapproved assets before moving to send", async () => {
  const address = "0x0000000000000000000000000000000000000007";
  const pair = getAddress(PAIRS.hood[2][1]);
  const hash = "0x" + "91".repeat(32);
  let approved = true, simulated = false, sends = 0, receipt;
  const assertLaunch = (tx) => {
    const { args } = abi.parseTransaction(tx);
    assert.equal(args[0][6], 125n);
    assert.equal(args[0][7], true);
    assert.equal(args[0][8], hash);
    assert.equal(args[2], pair);
    assert.deepEqual([...args[3]], [address]);
    assert.equal(tx.value, 500n);
  };
  const signer = {
    provider: { getNetwork: async () => ({ chainId: 4663n }), getTransactionReceipt: async () => receipt }, getAddress: async () => address,
    call: async (tx) => {
      const { name } = abi.parseTransaction(tx);
      if (name === "launchToken") { assertLaunch(tx); simulated = true; }
      const returns = { launchConfigCount: [1], getLaunchConfig: [[1, 1, 1, 1, 1, 1, true]], launchFee: [500],
        canLaunch: [true], maxCreatorTaxBps: [1000], approvedPairTokens: [approved],
        pairTokenEconomics: [1, 1, 18], previewLaunchEconomics: [hash], launchToken: [address, address] };
      return abi.encodeFunctionResult(name, returns[name]);
    },
    sendTransaction: async (tx) => {
      assertLaunch(tx); assert.ok(simulated); sends++;
      const log = abi.encodeEventLog(abi.getEvent("TokenLaunched"), [address, address, address, pair, 0, 1]);
      receipt = { hash, status: 1, logs: [{ ...log, address: FACTORY }] }; return { hash };
    },
  };
  const options = { pair, creatorFee: "125", recipient: "", buyback: true, exemptions: address };
  const launch = { signer, name: "Fixture", symbol: "FIX", logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, options, onStep() {} };
  assert.equal((await launchOnPons(launch)).token, address);
  approved = false;
  await assert.rejects(launchOnPons(launch), /not enabled/);
  assert.equal(sends, 1);
});

test("Pons routes stock and ETH opening buys with a minimum output and exact allowance", async () => {
  const user = "0x0000000000000000000000000000000000000007";
  const stock = getAddress(PAIRS.hood[2][1]);
  const hash = "0x" + "92".repeat(32);
  const fee = 500n;
  const openingQuote = 125000n;
  const minimum = 25n * 10n ** 18n;
  let allowance = 0n;
  let balance = openingQuote;
  let receipt;
  let pair = stock;
  let failSimulation = false;
  const sent = [];
  const signer = {
    provider: { getNetwork: async () => ({ chainId: 4663n }), getTransactionReceipt: async () => receipt },
    getAddress: async () => user,
    call: async (tx) => {
      const { name, args } = abi.parseTransaction(tx);
      if (name === "approve") assert.deepEqual([...args], [LAUNCH_AND_BUY, openingQuote]);
      if (name === "launchAndBuy" && failSimulation) throw new Error("minimum output not met");
      const results = {
        launchConfigCount: [1], getLaunchConfig: [[1, 1, 1, 1, 1, 1, true]], launchFee: [fee],
        canLaunch: [true], maxCreatorTaxBps: [1000], approvedPairTokens: [true], pairTokenEconomics: [1, 1, 6],
        previewLaunchEconomics: [hash], balanceOf: [balance], allowance: [allowance], approve: [true],
        launchAndBuy: [user, user, minimum],
      };
      return abi.encodeFunctionResult(name, results[name]);
    },
    sendTransaction: async (tx) => {
      const { name, args } = abi.parseTransaction(tx);
      sent.push(name);
      if (name === "approve") {
        assert.equal(getAddress(tx.to), stock);
        assert.deepEqual([...args], [LAUNCH_AND_BUY, openingQuote]);
        allowance = args[1];
        receipt = { hash, status: 1, logs: [] };
      } else {
        assert.equal(name, "launchAndBuy");
        assert.equal(getAddress(tx.to), LAUNCH_AND_BUY);
        assert.equal(args[0][8], hash);
        assert.equal(args[2], pair);
        assert.equal(args[3], pair === stock ? openingQuote : 125n * 10n ** 15n);
        assert.equal(args[4], minimum);
        assert.equal(args[5], user);
        assert.equal(tx.value, fee + (pair === stock ? 0n : args[3]));
        const log = abi.encodeEventLog(abi.getEvent("TokenLaunched"), [user, user, user, pair, 0, 1]);
        receipt = { hash, status: 1, logs: [{ ...log, address: FACTORY }] };
      }
      return { hash };
    },
  };
  const options = { pair: stock, initialBuy: "0.125", minTokensOut: "25", exemptions: "" };
  const socials = { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
  const launch = { signer, name: "Fixture", symbol: "FIX", logo: "", description: "", options, socials, onStep() {} };
  await assert.rejects(launchOnPons({ ...launch, options: { ...options, minTokensOut: "0" } }), /positive minimum/);
  balance = 0n;
  await assert.rejects(launchOnPons(launch), /enough of the quote asset/);
  assert.deepEqual(sent, []);
  balance = openingQuote;
  assert.equal((await launchOnPons(launch)).token, user);
  assert.deepEqual(sent, ["approve", "launchAndBuy"]);
  failSimulation = true;
  await assert.rejects(launchOnPons(launch), /minimum output not met/);
  assert.deepEqual(sent, ["approve", "launchAndBuy"]);
  failSimulation = false;
  pair = ZeroAddress;
  assert.equal((await launchOnPons({ ...launch, options: { ...options, pair: "" } })).token, user);
  assert.deepEqual(sent, ["approve", "launchAndBuy", "launchAndBuy"]);
});
