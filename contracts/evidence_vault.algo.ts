import {
  Contract,
  Address,
  GlobalState,
  BoxMap,
  abimethod,
  assert,
  Global,
  Txn,
  log,
  itob,
  bytes,
  uint64,
} from '@algorandfoundation/algorand-typescript'

/**
 * ClaimRecord — ARC-4 struct stored per claim in box storage.
 * All percentage values use 3 decimal places (e.g. 94_700 = 94.7%).
 */
type ClaimRecord = {
  submitter: Address
  category: bytes            // "academic" | "civic" | "journalism" | "dao"
  evidenceHash: bytes        // SHA-256 of off-chain evidence bundle
  truthScore: uint64         // 0–100_000
  consistencyPct: uint64     // factual consistency sub-score
  reliabilityPct: uint64     // source reliability sub-score
  contradictionPct: uint64   // contradiction index (lower = better)
  aiSummaryHash: bytes       // SHA-256 of AI-generated voter summary
  sealedAt: uint64           // Global.latestTimestamp at seal time
  sealedBlock: uint64        // Global.round at seal time
  status: uint64             // 0=pending, 1=verified, 2=contested, 3=disputed
}

/**
 * EvidenceVault
 *
 * Core Aletheia contract. Stores claims and AI-generated truth scores
 * as immutable on-chain records. Only an authorised VerificationOracle
 * app can seal verification results.
 *
 * @arc4 ARC-4 ABI compliant
 * @arc56 Extended metadata in artifacts/EvidenceVault.arc56.json
 */
export class EvidenceVault extends Contract {
  // ── Global State ──────────────────────────────────────────────

  /** Multisig admin — controls oracle reference updates */
  appAdmin = GlobalState<Address>()

  /** App ID of the authorised VerificationOracle */
  oracleAppId = GlobalState<uint64>()

  /** Monotonic counter of all sealed claims */
  totalClaims = GlobalState<uint64>({ initialValue: 0n })

  // ── Box Storage ───────────────────────────────────────────────

  /**
   * Key: claimId (SHA-256 of claim content, 32 bytes)
   * Value: ClaimRecord (ABI-encoded)
   */
  claims = BoxMap<bytes, ClaimRecord>({ keyPrefix: 'c:' })

  // ── Lifecycle ─────────────────────────────────────────────────

  @abimethod({ onCreate: 'require' })
  create(admin: Address, oracleAppId: uint64): void {
    this.appAdmin.value = admin
    this.oracleAppId.value = oracleAppId
    log('EvidenceVault created')
  }

  // ── Public Methods ────────────────────────────────────────────

  /**
   * Submit a new claim. Caller pays for box MBR.
   * Status is set to pending (0) until oracle seals a score.
   */
  @abimethod()
  submitClaim(
    claimId: bytes,
    category: bytes,
    evidenceHash: bytes,
  ): void {
    assert(!this.claims(claimId).exists, 'Claim already exists')
    assert(claimId.length === 32, 'claimId must be 32 bytes (SHA-256)')
    assert(evidenceHash.length === 32, 'evidenceHash must be 32 bytes (SHA-256)')

    this.claims(claimId).value = {
      submitter: Txn.sender,
      category,
      evidenceHash,
      truthScore: 0n,
      consistencyPct: 0n,
      reliabilityPct: 0n,
      contradictionPct: 0n,
      aiSummaryHash: bytes(''),
      sealedAt: 0n,
      sealedBlock: 0n,
      status: 0n, // pending
    }

    log('CLAIM_SUBMITTED:' + claimId)
  }

  /**
   * Seal a verified truth score. Only callable by the authorised
   * VerificationOracle app via inner transaction.
   *
   * This is the critical trust anchor — once sealed, a claim record
   * is immutable. No update path exists.
   */
  @abimethod()
  sealVerification(
    claimId: bytes,
    truthScore: uint64,
    consistencyPct: uint64,
    reliabilityPct: uint64,
    contradictionPct: uint64,
    aiSummaryHash: bytes,
  ): void {
    // ── Auth: must be called by the oracle app ──
    assert(
      Txn.sender === Global.currentApplicationAddress,
      'sealVerification must be called via inner transaction from oracle',
    )

    // ── Range checks ──
    assert(truthScore <= 100_000n, 'truthScore out of range')
    assert(consistencyPct <= 100_000n, 'consistencyPct out of range')
    assert(reliabilityPct <= 100_000n, 'reliabilityPct out of range')
    assert(contradictionPct <= 100_000n, 'contradictionPct out of range')
    assert(aiSummaryHash.length === 32, 'aiSummaryHash must be 32 bytes')

    // ── State checks ──
    assert(this.claims(claimId).exists, 'Claim does not exist')
    const record = this.claims(claimId).value
    assert(record.status === 0n, 'Claim already sealed')

    // ── Determine status from score ──
    let status: uint64 = 1n // verified
    if (truthScore < 50_000n) {
      status = 3n // disputed
    } else if (truthScore < 70_000n) {
      status = 2n // contested
    }

    // ── Seal — immutable from this point ──
    this.claims(claimId).value = {
      ...record,
      truthScore,
      consistencyPct,
      reliabilityPct,
      contradictionPct,
      aiSummaryHash,
      sealedAt: Global.latestTimestamp,
      sealedBlock: Global.round,
      status,
    }

    this.totalClaims.value = this.totalClaims.value + 1n

    log('CLAIM_SEALED:' + claimId + ':score=' + itob(truthScore))
  }

  // ── Read-only Methods ─────────────────────────────────────────

  /** Returns the full claim record. Used by GovernanceRoom before opening a vote. */
  @abimethod({ readonly: true })
  getClaimRecord(claimId: bytes): ClaimRecord {
    assert(this.claims(claimId).exists, 'Claim does not exist')
    return this.claims(claimId).value
  }

  /** Returns true if the claim exists and has been verified (status >= 1). */
  @abimethod({ readonly: true })
  isVerified(claimId: bytes): boolean {
    if (!this.claims(claimId).exists) return false
    return this.claims(claimId).value.status >= 1n
  }

  // ── Admin Methods ─────────────────────────────────────────────

  /** Update the authorised oracle app reference. Admin only. */
  @abimethod()
  updateOracleRef(newOracleAppId: uint64): void {
    assert(Txn.sender === this.appAdmin.value, 'Admin only')
    this.oracleAppId.value = newOracleAppId
    log('ORACLE_REF_UPDATED:' + itob(newOracleAppId))
  }
}
