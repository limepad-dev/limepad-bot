import { createPublicClient, createWalletClient, http, parseAbiItem, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const PK = process.env.CRON_PRIVATE_KEY;

if (!PK) {
  console.error("CRON_PRIVATE_KEY not set");
  process.exit(1);
}

const FACTORY = "0x5dd70c957f264632BE0F33c5Ee801Dc10089DdF5";
const FEE_LOCKER = "0x5a8cd3F31Fa8F558B435B76a935ec12950A1D2Bc";

// Сколько блоков назад сканировать Swap-events (~15 минут)
const SCAN_BLOCKS = 2000n;

const CHAIN = {
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const LAUNCH_EVENT = parseAbiItem(
  "event DirectTokenLaunched(address indexed token, address indexed creator, address indexed pool, uint256 positionTokenId, uint128 liquidity, uint256 nativeLiquidityUsed, uint256 tokenLiquidityUsed, uint160 sqrtPriceX96, uint24 fee, uint256 initialBuyNativeAmount, uint256 initialBuyTokenAmount)"
);

const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);

const FEE_LOCKER_ABI = [
  {
    type: "function",
    name: "collectAndEscrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "tokenFees", type: "uint256" },
      { name: "revenueAssetFees", type: "uint256" },
      { name: "swappedRevenueAsset", type: "uint256" },
      { name: "creatorEscrowed", type: "uint256" },
      { name: "protocolPaid", type: "uint256" },
    ],
  },
];

async function main() {
  const account = privateKeyToAccount(PK.startsWith("0x") ? PK : `0x${PK}`);
  console.log("Bot address:", account.address);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest > SCAN_BLOCKS ? latest - SCAN_BLOCKS : 0n;
  console.log(`Scanning blocks ${fromBlock} → ${latest}`);

  const launches = await publicClient.getLogs({
    address: FACTORY,
    event: LAUNCH_EVENT,
    fromBlock: 0n,
    toBlock: latest,
  });
  console.log(`Total launches: ${launches.length}`);

  const tokens = launches.map((log) => {
    const { args } = decodeEventLog({ abi: [LAUNCH_EVENT], data: log.data, topics: log.topics });
    return { token: args.token, pool: args.pool };
  });

  // Фильтр: только пулы с недавними Swap-events
  const poolsWithActivity = new Set();
  for (const { pool } of tokens) {
    try {
      const swaps = await publicClient.getLogs({
        address: pool,
        event: SWAP_EVENT,
        fromBlock,
        toBlock: latest,
      });
      if (swaps.length > 0) {
        poolsWithActivity.add(pool.toLowerCase());
        console.log(`  Activity: ${pool} (${swaps.length} swaps)`);
      }
    } catch (e) {
      console.warn(`  Pool scan failed ${pool}:`, e.shortMessage || e.message);
    }
  }
  console.log(`Pools with recent activity: ${poolsWithActivity.size}`);

  let collected = 0, skipped = 0, failed = 0;

  for (const { token, pool } of tokens) {
    if (!poolsWithActivity.has(pool.toLowerCase())) {
      skipped++;
      continue;
    }

    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

      await publicClient.simulateContract({
        account,
        address: FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: "collectAndEscrow",
        args: [token, 1n, deadline],
      });

      const hash = await walletClient.writeContract({
        address: FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: "collectAndEscrow",
        args: [token, 1n, deadline],
        account,
        chain: CHAIN,
      });

      console.log(`[collect] ${token} → ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") collected++;
      else failed++;
    } catch (e) {
      console.log(`[skip] ${token}: ${e.shortMessage || e.message}`);
      skipped++;
    }
  }

  console.log(`\nResult: collected=${collected}, skipped=${skipped}, failed=${failed}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
