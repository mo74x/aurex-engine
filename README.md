# AUREX Multi-Country Gold Engine

### Enterprise Multi-Jurisdiction Physical & Fractional Gold Trading, Settlement, & Double-Entry Accounting Platform

[![NestJS](https://img.shields.io/badge/Framework-NestJS%20v11-ea2845?style=flat-square&logo=nestjs)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript%205.7-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/ORM-Prisma%20v7.10-2d3748?style=flat-square&logo=prisma)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL%2016-336791?style=flat-square&logo=postgresql)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Cache%20%26%20Streams-Redis%207-dc382d?style=flat-square&logo=redis)](https://redis.io/)
[![Tests](https://img.shields.io/badge/Tests-27%20Passed-brightgreen?style=flat-square)](<>)
[![License](https://img.shields.io/badge/License-Proprietary-gold?style=flat-square)](<>)

---

## Table of Contents

1. [Executive Summary](#-executive-summary)
2. [End-to-End System Architecture](#-end-to-end-system-architecture)
3. [Zero-Leak Stream Fanout Architecture](#-zero-leak-stream-fanout-architecture)
4. [Double-Entry Accounting & Ledger Topology](#-double-entry-accounting--ledger-topology)
5. [Database Entity-Relationship Model (ERD)](#-database-entity-relationship-model-erd)
6. [Asymmetric Late-Payment Settlement Engine](#-asymmetric-late-payment-settlement-engine)
7. [Fractional 24K Vault & Instant Liquidity Engine](#-fractional-24k-vault--instant-liquidity-engine)
8. [Regional Tax, VAT, & Market Calibration Mechanics](#-regional-tax-vat--market-calibration-mechanics)
9. [Finite State Machines (Order & Ingot Lifecycles)](#-finite-state-machines-order--ingot-lifecycles)
10. [Security & Cryptographic Guarantees](#-security--cryptographic-guarantees)
11. [Complete API Reference & Data Contracts](#-complete-api-reference--data-contracts)
12. [Observability, Health & Diagnostics](#-observability-health--diagnostics)
13. [Getting Started & Production Runbook](#-getting-started--production-runbook)

---

## Executive Summary

The **Aurex Multi-Country Gold Engine** is an institutional-grade backend core engineered for high-throughput, low-latency gold bullion commerce and fractional wealth accumulation across four core Middle Eastern jurisdictions:

- 🇪🇬 **Egypt (EG)**: High-volatility market anchored by the Cairo Sagha street gold benchmark, featuring localized 14% VAT on manufacturing charges (_Masna'eya_) and dynamic Sagha Dollar calibration.
- 🇸🇦 **Saudi Arabia (SA)**: Regulated GCC market operating under SAMA guidelines, featuring pegged SAR forex, 0% VAT on investment bullion (>=99% pure), and 15% VAT on ornamental jewelry.
- 🇦🇪 **United Arab Emirates (AE)**: Dubai gold hub operating under pegged AED forex, 0% VAT on qualifying investment bars, and 5% VAT on commemorative coins and jewelry.
- 🇴🇲 **Oman (OM)**: High-precision market denominated in Omani Rials with mandatory 3-decimal point precision (_Baisa_) and 5% VAT rules.

---

## End-to-End System Architecture

The following diagram illustrates the flow of market ticks, quotation requests, payment webhook settlement, and ledger postings across service boundaries:

```mermaid
flowchart TD
    subgraph MarketIngestion ["1. Upstream Market Data Ingestion"]
        WS["Twelvedata Live XAU/USD Feed"] -->|WebSocket Quotes| XAUStream["XauStreamService"]
        LocalSim["Deterministic Micro-Tick Simulator"] -.->|Fallback 1s Ticks| XAUStream
        XAUStream -->|Raw Bid/Ask| PricingSvc["PricingService"]
    end

    subgraph DynamicCalibration ["2. Regional Forex & Sagha Engine"]
        SaghaAdmin["Sagha Admin Desks"] -->|Target 21K Anchor / Manual FX| SaghaCtrl["SaghaAdminController"]
        SaghaCtrl --> SaghaService["SaghaCalibrationService"]
        SaghaService -->|Calibrated Implied USD Rate| PricingSvc
        PricingSvc -->|Compute Regional Karats| RedisPubSub[("Redis Pub/Sub & Key-Value Cache")]
    end

    subgraph StreamMultiplexer ["3. High-Concurrency Stream Fanout"]
        RedisPubSub -->|Single Subscriber| Broadcaster["PriceBroadcasterService"]
        Broadcaster -->|RxJS Subject EG| SSE_EG["SSE Stream /api/prices/stream/EG"]
        Broadcaster -->|RxJS Subject SA| SSE_SA["SSE Stream /api/prices/stream/SA"]
        Broadcaster -->|RxJS Subject AE| SSE_AE["SSE Stream /api/prices/stream/AE"]
        Broadcaster -->|RxJS Subject OM| SSE_OM["SSE Stream /api/prices/stream/OM"]
    end

    subgraph CommerceLayer ["4. Cart, Valuation & 5-Min Price Locks"]
        ClientApp["Mobile / Web Client"] -->|Request SKU Pricing| CalcCtrl["CheckoutController"]
        CalcCtrl --> ProductCalc["ProductCalculatorService"]
        CalcCtrl -->|Lock Cart Price| LockSvc["PriceLockService"]
        LockSvc -->|Sign Payload & Set 300s TTL| RedisPubSub
    end

    subgraph SettlementLayer ["5. Payment Ingestion & Settlement"]
        Gateways["InstaPay / Mada / Apple Pay"] -->|Inbound Webhook| WebhookCtrl["PaymentWebhookController"]
        WebhookCtrl -->|Constant-Time HMAC Check| SettleSvc["PaymentSettlementService"]
        SettleSvc -->|Idempotency Check| RedisPubSub
        SettleSvc -->|Slippage <= 0.35%| LedgerSvc["VaultLedgerService"]
        SettleSvc -->|Slippage > 0.35%| EscrowHold["Hold in Escrow / Top-Up / Refund"]
    end

    subgraph PersistenceLayer ["6. Ledger & PostgreSQL Persistence"]
        LedgerSvc -->|Double-Entry Journal| Postgres[("PostgreSQL Database")]
        LedgerSvc -->|Allocate Serials FOR UPDATE SKIP LOCKED| PhysicalBars[("Physical Gold Vault Inventory")]
        FracSvc["FractionalVaultService"] -->|Debit House Pool / Credit User Vault| LedgerSvc
    end
```

---

## Zero-Leak Stream Fanout Architecture

In financial applications with streaming prices, creating a dedicated Redis connection for each Server-Sent Events (SSE) subscriber leads to rapid connection pool exhaustion. Aurex implements an in-memory multiplexer pattern:

```mermaid
sequenceDiagram
    autonumber
    participant Redis as Redis Pub/Sub
    participant PBS as PriceBroadcasterService (Singleton)
    participant Client1 as Client App (Cairo)
    participant Client2 as Client App (Riyadh)
    participant Client3 as Client App (Dubai)

    Note over PBS,Redis: Single Persistent Subscriber Connection
    PBS->>Redis: SUBSCRIBE aurex:stream:EG aurex:stream:SA aurex:stream:AE aurex:stream:OM

    Client1->>PBS: Connect GET /api/prices/stream/EG
    Client2->>PBS: Connect GET /api/prices/stream/SA
    Client3->>PBS: Connect GET /api/prices/stream/AE

    Redis-->>PBS: Publish tick on aurex:stream:EG
    PBS->>Client1: SSE MessageEvent (data: latest EG tick)
    Note over Client2,Client3: SA and AE clients remain idle

    Redis-->>PBS: Publish tick on aurex:stream:SA
    PBS->>Client2: SSE MessageEvent (data: latest SA tick)

    Note over PBS: Total Redis TCP Connections: Exactly 1
```

---

## Double-Entry Accounting & Ledger Topology

Every balance movement in Aurex is recorded as an immutable double-entry journal transaction. Total Debits strictly equal Total Credits.

### Chart of Accounts

| Account Code Template                              | Account Type | Balance Normal | Invariant / Overdraft Rule                                |
| :------------------------------------------------- | :----------- | :------------- | :-------------------------------------------------------- |
| `ASSET:GATEWAY_CLEARING:<CURRENCY>`                | `ASSET`      | Debit (+)      | Inbound payment gateway clearing account                  |
| `ASSET:PAYOUT_CLEARING:<CURRENCY>`                 | `ASSET`      | Debit (+)      | Outbound customer refund / disbursement account           |
| `ASSET:TREASURY_GOLD_DESK:<CURRENCY>`              | `ASSET`      | Debit (+)      | Internal bullion inventory and buyback desk               |
| `ASSET:PHYSICAL_VAULT_POOL:<COUNTRY>:XAU_G`        | `ASSET`      | Debit (+)      | Physical 100g/1000g bars backing the fractional pool      |
| `LIABILITY:USER_ESCROW:<USER_ID>:<CURRENCY>`       | `LIABILITY`  | Credit (+)     | Customer unspent fiat balance. **CANNOT DROP < 0**        |
| `LIABILITY:USER_GOLD_VAULT:<USER_ID>:XAU_G`        | `LIABILITY`  | Credit (+)     | Customer fractional 24K gold balance. **CANNOT DROP < 0** |
| `LIABILITY:HOUSE_UNALLOCATED_POOL:<COUNTRY>:XAU_G` | `LIABILITY`  | Credit (+)     | Available fractional grams for sale. **CANNOT DROP < 0**  |
| `REVENUE:GOLD_SALES:<CURRENCY>`                    | `REVENUE`    | Credit (+)     | Recognized revenue from physical bullion sales            |
| `REVENUE:FRACTIONAL_GOLD_SALES:<CURRENCY>`         | `REVENUE`    | Credit (+)     | Recognized revenue from fractional 24K sales              |
| `REVENUE:BUYBACK_LIQUIDATION_FEE:<CURRENCY>`       | `REVENUE`    | Credit (+)     | 0.15% dealer fee captured upon customer liquidation       |
| `EXPENSE:SLIPPAGE_ABSORBED:<CURRENCY>`             | `EXPENSE`    | Debit (+)      | Cost absorbed by dealer on late payments (<= 0.35%)       |

### Standard T-Account Journal Examples

#### A. Standard Inbound Order Settlement (With 0.25% Dealer Absorbed Slippage)

```text
1. INBOUND DEPOSIT LEG:
   DEBIT  ASSET:GATEWAY_CLEARING:EGP               10,000.00 EGP
   CREDIT LIABILITY:USER_ESCROW:usr_42:EGP         10,000.00 EGP

2. SETTLEMENT & REVENUE SWEEP LEG:
   DEBIT  LIABILITY:USER_ESCROW:usr_42:EGP         10,000.00 EGP
   DEBIT  EXPENSE:SLIPPAGE_ABSORBED:EGP                25.00 EGP  (Dealer absorbs 0.25%)
   CREDIT REVENUE:GOLD_SALES:EGP                   10,025.00 EGP  (Total recognized revenue)
   --------------------------------------------------------------------------------------
   TOTAL DEBITS: 20,025.00 EGP  |  TOTAL CREDITS: 20,025.00 EGP  (BALANCED)
```

#### B. Fractional 24K Gold Purchase (1.0000g @ 4,450.00 EGP)

```text
1. FIAT BOOK:
   DEBIT  LIABILITY:USER_ESCROW:usr_42:EGP          4,450.00 EGP  (User fiat balance decreases)
   CREDIT REVENUE:FRACTIONAL_GOLD_SALES:EGP        4,450.00 EGP  (Aurex recognizes fiat revenue)

2. GOLD BOOK (XAU_G):
   DEBIT  LIABILITY:HOUSE_UNALLOCATED_POOL:EG:XAU_G  1.0000g       (Available pool decreases)
   CREDIT LIABILITY:USER_GOLD_VAULT:usr_42:XAU_G     1.0000g       (User gold balance increases)
   --------------------------------------------------------------------------------------
   100% Physically Backed Invariant: Backing Bar Grams >= Sum of User Vault Grams
```

---

## Database Entity-Relationship Model (ERD)

```mermaid
erDiagram
    CountryPricingProfile ||--o{ GoldProduct : "catalogs"
    CountryPricingProfile {
        string countryCode PK "VarChar(2) - EG, SA, AE, OM"
        string currency "VarChar(3)"
        int decimals "2 or 3"
        enum fxMode "PEGGED, LIVE_FOREX, SAGHA_OVERRIDE"
        decimal officialFxRate "12, 4"
        decimal overrideFxRate "12, 4"
        decimal localMarketPremiumPct "6, 4"
        decimal askSpreadPct "6, 4"
        decimal bidSpreadPct "6, 4"
        decimal vatBullionPct "5, 4"
        decimal vatJewelryPct "5, 4"
        boolean isActive
        datetime updatedAt
    }

    GoldProduct {
        string id PK "UUID"
        string sku UK "e.g. EG-BTC-10G-24K"
        string countryCode FK
        string name
        int karat "24, 22, 21, 18"
        decimal weightGrams "10, 4"
        decimal makingFeePerGram "10, 2"
        decimal cashbackPerGram "10, 2"
        boolean isInvestmentBullion
    }

    LedgerAccount ||--o{ LedgerEntry : "contains"
    LedgerAccount {
        string id PK "UUID"
        string code UK "e.g. LIABILITY:USER_ESCROW:usr_1:EGP"
        string name
        enum type "ASSET, LIABILITY, REVENUE, EXPENSE"
        string currency "VarChar(6)"
        decimal balance "18, 4"
        int version
        datetime createdAt
        datetime updatedAt
    }

    JournalTransaction ||--o{ LedgerEntry : "composed of"
    JournalTransaction {
        string id PK "UUID"
        string idempotencyKey UK
        string referenceType "ORDER_SETTLEMENT, ESCROW_DEPOSIT, etc."
        string referenceId
        string description
        datetime postedAt
    }

    LedgerEntry {
        string id PK "UUID"
        string transactionId FK
        string accountId FK
        enum direction "DEBIT, CREDIT"
        decimal amount "18, 4"
        decimal runningAfter "18, 4"
        datetime createdAt
    }

    PhysicalGoldIngot }o--o| GoldOrder : "allocated to"
    PhysicalGoldIngot {
        string id PK "UUID"
        string serialNumber UK "Tamper-proof serial"
        string sku
        string countryCode
        string vaultLocation
        int karat
        decimal weightGrams "10, 4"
        string assayCertHash "SHA-256"
        enum status "AVAILABLE, ALLOCATED, MASTER_POOL_BACKING, etc."
        string allocatedOrderId FK
        string allocatedUserId
        datetime allocatedAt
        int version
    }

    GoldOrder {
        string id PK "UUID"
        string quoteId UK
        string userId
        string countryCode
        string currency
        enum status "ESCROW_HOLD, ALLOCATED_READY_TO_SHIP, REFUNDED"
        decimal lockedGrandTotal "18, 4"
        decimal finalSettledTotal "18, 4"
        decimal paidAmount "18, 4"
        decimal absorbedSlippageCost "18, 4"
        decimal requiredTopUpAmount "18, 4"
        datetime createdAt
        datetime updatedAt
    }

    GoldVaultPosition {
        string id PK "UUID"
        string userId UK
        string countryCode UK
        string currency
        decimal totalGrams24k "18, 4"
        decimal weightedAvgCostPerG "18, 4"
        decimal realizedPnl "18, 4"
        datetime updatedAt
    }
```

---

## Asymmetric Late-Payment Settlement Engine

When a customer initiates an instant payment (e.g. via Egyptian InstaPay or Saudi Mada), the settlement webhook may arrive after the 5-minute price lock has expired. Aurex handles this via an asymmetric slippage engine:

```mermaid
flowchart TD
    Start([Webhook Arrives with Payment]) --> Idempotency{"First Time Seen? (Redis NX)"}
    Idempotency -- No --> ReturnCached[Return Cached Settlement Decision]
    Idempotency -- Yes --> AcquireQuote[Atomically Acquire Quote via Lua]

    AcquireQuote --> TimingCheck{"Arrived within 5-min Lock?"}

    TimingCheck -- Yes (ON_TIME) --> SettleFast["1. Settle at Locked Price<br/>2. Post Double-Entry Legs<br/>3. Allocate Ingot Serials"]

    TimingCheck -- No (LATE_WITHIN_GRACE) --> RecalcLive["Recalculate Cart at Live Price Tick"]
    RecalcLive --> CalcDiff["Calculate Slippage %:<br/>(LiveTotal - LockedTotal) / LockedTotal * 100"]

    CalcDiff --> CheckSlippage{"Slippage Direction & Pct?"}

    CheckSlippage -- "Slippage <= 0% (Gold dropped or flat)" --> SettleNoSlip["Settle at Locked Price<br/>Customer keeps locked quote benefit"]
    CheckSlippage -- "0% < Slippage <= 0.35%" --> SettleAbsorb["Settle Order<br/>Dealer absorbs difference as EXPENSE:SLIPPAGE_ABSORBED"]
    CheckSlippage -- "Slippage > 0.35% (Gold spiked)" --> HoldEscrow["Place Funds in Customer Escrow<br/>Status: ESCROW_HOLD<br/>Create 10-Min Top-Up Lock"]

    HoldEscrow --> Resolution{"Customer Resolution Choice"}
    Resolution -- Option A --> TopUp["POST /api/checkout/escrow/:quoteId/top-up<br/>Customer pays difference -> Serials allocated"]
    Resolution -- Option B --> Refund["POST /api/checkout/escrow/:quoteId/refund<br/>Instant 1-Click Payout Clearing Refund"]
```

---

## Fractional 24K Vault & Instant Liquidity Engine

Users can accumulate fractional 24K gold with as little as 0.0100 grams, backed 100% by physical bars in the vault:

```mermaid
sequenceDiagram
    autonumber
    participant User as Customer
    participant FVC as FractionalVaultController
    participant FVS as FractionalVaultService
    participant Ledger as VaultLedgerService
    participant DB as PostgreSQL (GoldVaultPosition)

    User->>FVC: POST /api/vault/fractional/buy (grams: 2.5000g)
    FVC->>FVS: buyFractionalGold(params)
    FVS->>FVS: Verify Slippage Guard (Live Ask <= Max Acceptable)
    FVS->>Ledger: Post Fiat Journal (Debit User Escrow, Credit Fractional Sales)
    FVS->>Ledger: Post Gold Journal (Debit House Master Pool, Credit User Vault)
    FVS->>DB: Recalculate Weighted Average Cost (WAC) Position
    DB-->>FVS: Updated Position (Total Grams & New WAC)
    FVS-->>FVC: Execution confirmation with executionAskPerGram
    FVC-->>User: 200 OK (New Vault Grams & Cost Basis)

    Note over User,FVC: Later: Customer Liquidates Back to Fiat
    User->>FVC: POST /api/vault/fractional/sell-buyback (grams: 1.0000g)
    FVC->>FVS: sellGoldInstantBuyback(params)
    FVS->>FVS: Verify Slippage Guard (Live Bid >= Min Acceptable)
    FVS->>Ledger: Post Gold Journal (Debit User Vault, Credit House Pool)
    Note over Ledger: Overdraft Protection throws ConflictException if User Vault < 1.0g
    FVS->>Ledger: Post Fiat Journal (Debit Treasury, Credit User Escrow Net + Fee)
    FVS->>DB: Update Realized P&L = Net Proceeds - (Sold Grams * WAC)
    DB-->>FVS: Position updated
    FVS-->>User: 200 OK (Instant fiat credited to wallet + trade P&L)
```

---

## Regional Tax, VAT, & Market Calibration Mechanics

### 1. Regional Tax & VAT Calculation Matrix

| Country                  | Code | Currency | Decimals | Investment Bullion (24K >=99%) | Jewelry / Coins (<99% Karat) | Regional VAT Special Rules                                           |
| :----------------------- | :--- | :------- | :------- | :----------------------------- | :--------------------------- | :------------------------------------------------------------------- |
| **Egypt**                | `EG` | `EGP`    | 2        | 0% on Metal                    | 0% on Metal                  | **14% VAT applies exclusively to the Making Charge (_Masna'eya_)**   |
| **Saudi Arabia**         | `SA` | `SAR`    | 2        | 0% VAT Exempt                  | 15% Standard VAT             | Bullion qualifying under SAMA rules is completely zero-rated         |
| **United Arab Emirates** | `AE` | `AED`    | 2        | 0% VAT Exempt                  | 5% Standard VAT              | Investment precious metals exempt under UAE Federal Tax Authority    |
| **Oman**                 | `OM` | `OMR`    | 3        | 0% VAT Exempt                  | 5% Standard VAT              | **All monetary transactions computed in 3 decimal places (_Baisa_)** |

### 2. Egypt Sagha Implied Dollar Formula

In Egypt, local gold prices decouple from official bank foreign exchange rates. The engine reverse-calculates the implied Sagha Dollar:

$$\text{Price}_{\text{24K}} = \text{Price}_{\text{21K}} \times \frac{24}{21}$$

$$\text{Implied Ounce in EGP} = \text{Price}_{\text{24K}} \times 31.1034768$$

$$\text{Implied Sagha USD/EGP} = \frac{\text{Implied Ounce in EGP}}{\text{Spot XAU/USD}}$$

### 3. Weighted Average Cost (WAC) Formula

When customers accumulate fractional grams across fluctuating market ticks:

$$\text{WAC}_{\text{new}} = \frac{(\text{Grams}_{\text{held}} \times \text{WAC}_{\text{old}}) + (\text{Grams}_{\text{bought}} \times P_{\text{ask}})}{\text{Grams}_{\text{held}} + \text{Grams}_{\text{bought}}}$$

Upon sale, realized profit or loss is calculated:

$$\text{Realized P&L} = \text{Net Payout} - (\text{Grams}_{\text{sold}} \times \text{WAC})$$

---

## Finite State Machines (Order & Ingot Lifecycles)

### 1. Order Settlement Lifecycle (`GoldOrder`)

```mermaid
stateDiagram-v2
    [*] --> PENDING_PAYMENT : User locks 5-min quote
    PENDING_PAYMENT --> ALLOCATED_READY_TO_SHIP : Payment on-time OR slippage <= 0.35%
    PENDING_PAYMENT --> ESCROW_HOLD : Late payment with slippage > 0.35% OR underpaid
    ESCROW_HOLD --> ALLOCATED_READY_TO_SHIP : Customer completes Escrow Top-Up
    ESCROW_HOLD --> REFUNDED : Customer clicks Instant Escrow Refund
    ALLOCATED_READY_TO_SHIP --> [*] : Shipped to customer vault/address
    REFUNDED --> [*] : Funds returned via payout clearing
```

### 2. Physical Ingot Inventory Lifecycle (`PhysicalGoldIngot`)

```mermaid
stateDiagram-v2
    [*] --> AVAILABLE : Seeded / Received from refinery
    AVAILABLE --> ALLOCATED : Locked via FOR UPDATE SKIP LOCKED on checkout
    AVAILABLE --> MASTER_POOL_BACKING : Admin locks 24K bar to back fractional pool
    ALLOCATED --> SHIPPED : Vault dispatch to logistics
    MASTER_POOL_BACKING --> AVAILABLE : Unlocked by vault officer upon pool reconciliation
    SHIPPED --> BUYBACK_RETURNED : Customer physical buyback at vault desk
    BUYBACK_RETURNED --> AVAILABLE : Re-assayed & verified
```

---

## Security & Cryptographic Guarantees

1. **Constant-Time Timing-Safe HMAC Verification**:
   - Webhook HMAC-SHA256 signatures and Admin API Keys are checked using `crypto.timingSafeEqual` with byte buffers. This guarantees immunity to side-channel timing attacks.
2. **Deterministic Account Locking**:
   - Ledger accounts are sorted alphabetically by account code before execution. PostgreSQL acquires row-level locks via `SELECT ... FOR UPDATE` in this strict order, eliminating deadlocks under high concurrency.
3. **Overdraft Protection**:
   - Negative liability balance checks are enforced at the database transaction layer. Attempting to deduct more escrow or gold grams than a user possesses throws a `409 ConflictException` and rolls back the transaction.
4. **Tamper-Proof Ingot Assay Hashes**:
   - Every physical bar records an immutable SHA-256 hash derived from its serial number and assay certificate.

---

## Complete API Reference & Data Contracts

### 1. Market Data & Pricing

#### `GET /api/prices/latest/:country`

Fetch the latest sub-second pricing snapshot for a specific country.

- **Parameters**: `country` (`EG`, `SA`, `AE`, `OM`)
- **Response `200 OK`**:

```json
{
  "country": "EG",
  "currency": "EGP",
  "timestamp": 1731301200000,
  "spotUsd": { "bid": 2745.3, "ask": 2745.6 },
  "fxRate": 53.99,
  "karats": {
    "24K": { "ask": 4768.12, "bid": 4720.45 },
    "22K": { "ask": 4370.78, "bid": 4327.08 },
    "21K": { "ask": 4172.11, "bid": 4130.39 },
    "18K": { "ask": 3576.09, "bid": 3540.34 }
  },
  "units": {
    "goldPound8g21k": { "ask": 33376.88, "bid": 33043.12 },
    "tola24k": { "ask": 55614.45, "bid": 55058.2 },
    "ounce24k": { "ask": 148255.1, "bid": 146771.55 }
  }
}
```

#### `GET /api/prices/stream/:country` (SSE)

High-concurrency Server-Sent Events stream for real-time price feeds.

---

### 2. Checkout & Price Locks

#### `GET /api/checkout/sku/:sku?qty=1`

Get transparent price breakdown for a product.

- **Response `200 OK`**:

```json
{
  "sku": "EG-BTC-10G-24K",
  "name": "BTC 10g 24K Gold Ingot (Sealed)",
  "countryCode": "EG",
  "currency": "EGP",
  "karat": "24K",
  "weightGrams": 10,
  "quantity": 1,
  "unitBreakdown": {
    "rawGoldPricePerGram": 4768.12,
    "makingFeePerGram": 68.0,
    "vatAmountPerUnit": 95.2,
    "unitTotalAsk": 48456.4,
    "unitResaleBidSealed": 47484.5,
    "unitResaleBidOpened": 47314.5
  },
  "lineTotalAsk": 48456.4
}
```

#### `POST /api/checkout/lock`

Lock live prices for 5 minutes (300 seconds).

- **Request Body**:

```json
{
  "userId": "usr_99182",
  "countryCode": "EG",
  "items": [{ "sku": "EG-BTC-10G-24K", "quantity": 1 }]
}
```

- **Response `201 Created`**:

```json
{
  "quoteId": "q_7a2f1c8e9b0d1e2f3a4b",
  "userId": "usr_99182",
  "countryCode": "EG",
  "currency": "EGP",
  "grandTotal": 48456.4,
  "lockedAt": 1731301200000,
  "expiresAt": 1731301500000,
  "ttlSeconds": 300,
  "status": "ACTIVE",
  "signature": "d3b07384d113edec49eaa6238ad5ff00..."
}
```

#### `POST /api/checkout/confirm`

Confirm and settle order directly from pre-funded wallet balance.

- **Request Body**:

```json
{
  "quoteId": "q_7a2f1c8e9b0d1e2f3a4b",
  "userId": "usr_99182",
  "paymentReference": "WALLET_DIRECT_PAY"
}
```

---

### 3. Payment Webhooks

#### `POST /api/webhooks/payments/egypt-ipn`

Webhook receiver for Egyptian instant payment networks (InstaPay / Vodafone Cash).

- **Headers**: `x-aurex-signature: <hex-hmac>`
- **Request Body**:

```json
{
  "rrn": "410294819201",
  "quoteId": "q_7a2f1c8e9b0d1e2f3a4b",
  "userId": "usr_99182",
  "method": "EG_INSTAPAY",
  "amountEgp": 48456.4,
  "senderAddress": "arafa@instapay",
  "settledTimestampMs": 1731301260000
}
```

#### `POST /api/webhooks/payments/gcc-gateway`

Unified card and Apple Pay webhook for Saudi Arabia, UAE, and Oman.

- **Headers**: `x-aurex-signature: <hex-hmac>`

---

### 4. Escrow & Late-Payment Resolution

#### `POST /api/checkout/escrow/:quoteId/top-up`

Complete settlement by paying the spiked price difference.

- **Request Body**:

```json
{
  "userId": "usr_99182",
  "topUpTxId": "TOPUP_99182741",
  "topUpPaidAmount": 145.2,
  "items": [{ "sku": "EG-BTC-10G-24K", "quantity": 1 }]
}
```

#### `POST /api/checkout/escrow/:quoteId/refund`

Trigger instant 1-click refund for an order held in escrow.

- **Request Body**: `{ "userId": "usr_99182" }`

#### `GET /api/checkout/escrow/:quoteId/audit`

Retrieve the full double-entry audit trail, including all ledger entries and allocated bar serial numbers.

---

### 5. Fractional 24K Vault

#### `POST /api/vault/fractional/buy`

Buy fractional 24K gold using fiat wallet balance.

- **Request Body**:

```json
{
  "userId": "usr_99182",
  "countryCode": "EG",
  "gramsToBuy": 2.5,
  "maxAcceptableAskPerGram": 4775.0,
  "idempotencyKey": "buy_step_1092"
}
```

#### `POST /api/vault/fractional/sell-buyback`

Instant buyback: sell fractional 24K gold back to Aurex at live Bid.

- **Request Body**:

```json
{
  "userId": "usr_99182",
  "countryCode": "EG",
  "gramsToSell": 1.0,
  "minAcceptableBidPerGram": 4710.0,
  "idempotencyKey": "sell_step_1093"
}
```

#### `GET /api/vault/fractional/portfolio/:userId?country=EG`

Retrieve live portfolio valuation, weighted average cost basis, and unrealized/realized P&L.

---

### 6. Administration & Market Calibration (Protected)

_All admin endpoints require header `x-admin-key: <ADMIN_API_KEY>`._

#### `POST /api/admin/sagha/anchor-21k`

Anchor Egyptian pricing to street benchmark.

- **Request Body**:

```json
{
  "target21kEgp": 6275.0,
  "askSpreadPct": 0.004,
  "bidSpreadPct": 0.006,
  "adminName": "DESK_CHIEF"
}
```

#### `POST /api/admin/sagha/lock-fx`

Directly lock the implied Sagha Dollar forex rate.

- **Request Body**: `{ "saghaUsdEgp": 54.20, "adminName": "DESK_CHIEF" }`

#### `POST /api/admin/sagha/auto`

Resume automated background Sagha benchmark calibration.

#### `POST /api/vault/fractional/pool/load-bar`

Lock a physical 24K kilobar into the master fractional backing pool.

- **Request Body**: `{ "serialNumber": "BTC-EG-24K-1000G-001" }`

---

## Observability, Health & Diagnostics

### Readiness Health Probe

`GET /api/health` reports status across infrastructure dependencies:

```json
{
  "status": "HEALTHY",
  "uptimeSeconds": 14280,
  "timestamp": "2026-11-11T07:45:00.000Z",
  "checks": {
    "database": { "status": "UP" },
    "redis": { "status": "UP" },
    "marketFeed": {
      "status": "UP",
      "details": "Latest tick age: 1.2s"
    }
  }
}
```

---

## Getting Started & Production Runbook

### 1. Requirements

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### 2. Environment Setup

```bash
cp .env.example .env
```

Ensure `.env` contains valid credentials for `DATABASE_URL`, `REDIS_URL`, `ADMIN_API_KEY`, `PAYMENT_WEBHOOK_SECRET`, and `QUOTE_HMAC_SECRET`.

### 3. Build & Verify

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma Client
npx prisma generate

# 3. Run ESLint code-quality verification (0 errors, 0 warnings)
npm run lint

# 4. Run automated unit test suite (27 tests)
npm test

# 5. Build production bundle
npm run build

# 6. Start production server
npm run start:prod
```

### 4. Running the Multi-Scenario E2E Integration Suite

To verify end-to-end price updates, quote locking, InstaPay webhook settlement, and Sagha market spikes:

```bash
npm run test:e2e:aurex
```

---

## License

Proprietary & Confidential. All rights reserved by Aurex Gold Technologies.
