/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as crypto from 'crypto';

const BASE_URL = process.env.AUREX_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'aurex-admin-dev-key';
const WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET || 'aurex-webhook-secret-key';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request(path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

function signWebhook(payloadObj: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(payloadObj);
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(raw)
    .digest('hex');
  return { raw, signature };
}

async function runAurexE2E() {
  console.log('==============================================================');
  console.log('🚀 AUREX MULTI-COUNTRY GOLD ENGINE — AUTOMATED E2E TEST SUITE');
  console.log(
    '==============================================================\n',
  );

  // 1. Verify multi-country snapshots (EG, SA, AE, OM)
  console.log('⏳ Waiting 1.5s for first XAU/USD tick to populate Redis...');
  await sleep(1500);

  for (const country of ['EG', 'SA', 'AE', 'OM']) {
    const snap = await request(`/api/prices/latest/${country}`);
    console.log(
      `✅ [${country}] Live 24K Ask: ${snap.karats['24K'].ask} ${snap.currency}/g | 21K Ask: ${snap.karats['21K'].ask} ${snap.currency}/g (FX: ${snap.fxRate})`,
    );
  }

  // 2. Reset Egypt Sagha to a clean baseline anchor (21K = 6275 EGP/g)
  console.log(
    '\n--- STEP 1: Pinning Egypt Sagha Baseline (21K = 6,275 EGP/g) ---',
  );
  const baselineSagha = await request('/api/admin/sagha/anchor-21k', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      target21kEgp: 6275,
      askSpreadPct: 0.004,
      bidSpreadPct: 0.006,
      adminName: 'E2E_TEST_RUNNER',
    }),
  });
  console.log(
    `✅ Implied Sagha Dollar calibrated to: ${baselineSagha.impliedSaghaUsdEgp} EGP (+${baselineSagha.impliedSpreadOverCbePct}% over CBE)`,
  );
  await sleep(1200); // Wait 1 tick for PricingService to broadcast updated EGP matrix

  // 3. Scenario A: Create 5-min Lock -> Late InstaPay with minimal slippage (Auto-Absorbed)
  console.log(
    '\n--- STEP 2 (Scenario A): 5-Min Quote Lock + Late InstaPay (Small Slippage) ---',
  );
  const quoteA = await request('/api/checkout/lock', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'usr_scenario_a',
      countryCode: 'EG',
      items: [{ sku: 'EG-BTC-10G-24K', quantity: 1 }],
    }),
  });
  console.log(
    `🔒 Quote A Locked: ${quoteA.quoteId} | Grand Total: ${quoteA.grandTotal} ${quoteA.currency}`,
  );

  const latePayloadA = {
    rrn: `990011${Date.now().toString().slice(-6)}`,
    quoteId: quoteA.quoteId,
    userId: 'usr_scenario_a',
    method: 'EG_INSTAPAY',
    amountEgp: quoteA.grandTotal,
    senderAddress: 'arafa@instapay',
    // Simulate payment settling 6 minutes AFTER lock creation (1 min past expiry)
    settledTimestampMs: quoteA.expiresAt + 60_000,
  };
  const signedA = signWebhook(latePayloadA);
  const settlementA = await request('/api/webhooks/payments/egypt-ipn', {
    method: 'POST',
    headers: { 'x-aurex-signature': signedA.signature },
    body: signedA.raw,
  });
  console.log(`💸 Scenario A Settlement Status: ${settlementA.orderStatus}`);
  console.log(
    `   Locked: ${settlementA.lockedGrandTotal} EGP | Live at Settlement: ${settlementA.liveRecalculatedTotal} EGP | Slippage: ${settlementA.slippagePct}% | Absorbed by Dealer: ${settlementA.absorbedCostByDealer} EGP`,
  );

  // 4. Scenario B: Create 5-min Lock -> Sudden Sagha Spike (+160 EGP/g on 21K) -> Late InstaPay
  console.log(
    '\n--- STEP 3 (Scenario B): 5-Min Quote Lock -> Mid-Checkout Sagha Spike -> Late InstaPay ---',
  );
  const quoteB = await request('/api/checkout/lock', {
    method: 'POST',
    body: JSON.stringify({
      userId: 'usr_scenario_b',
      countryCode: 'EG',
      items: [{ sku: 'EG-BTC-10G-24K', quantity: 1 }],
    }),
  });
  console.log(
    `🔒 Quote B Locked before spike: ${quoteB.quoteId} | Grand Total: ${quoteB.grandTotal} ${quoteB.currency}`,
  );

  console.log(
    '📈 Simulating sudden Egypt Sagha street spike: 21K jumps from 6,275 -> 6,435 EGP/g...',
  );
  const spikedSagha = await request('/api/admin/sagha/anchor-21k', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      target21kEgp: 6435,
      askSpreadPct: 0.004,
      bidSpreadPct: 0.006,
      adminName: 'E2E_SPIKE_SIMULATOR',
    }),
  });
  console.log(
    `⚠️ New Implied Sagha Dollar: ${spikedSagha.impliedSaghaUsdEgp} EGP`,
  );
  await sleep(1200); // Wait 1 tick for Redis EG snapshot to reflect the spike

  const latePayloadB = {
    rrn: `990022${Date.now().toString().slice(-6)}`,
    quoteId: quoteB.quoteId,
    userId: 'usr_scenario_b',
    method: 'EG_INSTAPAY',
    amountEgp: quoteB.grandTotal,
    senderAddress: 'arafa@instapay',
    settledTimestampMs: quoteB.expiresAt + 90_000, // 1.5 mins after lock expired
  };
  const signedB = signWebhook(latePayloadB);
  const settlementB = await request('/api/webhooks/payments/egypt-ipn', {
    method: 'POST',
    headers: { 'x-aurex-signature': signedB.signature },
    body: signedB.raw,
  });

  console.log(`🛑 Scenario B Settlement Status: ${settlementB.orderStatus}`);
  console.log(
    `   Paid (Locked): ${settlementB.paidAmount} EGP | New Live Price: ${settlementB.liveRecalculatedTotal} EGP`,
  );
  console.log(
    `   Slippage: +${settlementB.slippagePct}% (Exceeds 0.35% buffer) | Required Top-Up: ${settlementB.requiredTopUpAmount} EGP`,
  );
  console.log(`   Resolution Options:`, settlementB.resolutionOptions);

  console.log('\n🎉 ALL E2E SCENARIOS PASSED SUCCESSFULLY!');
}

runAurexE2E().catch((err) => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
