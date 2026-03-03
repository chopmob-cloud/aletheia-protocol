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
  sendMethodCall,
} from '@algorandfoundation/algorand-typescript'

/**
 * VerificationOracle
 *
 * ASIF-constrained bridge between the off-chain AI verification service
 * and the on-chain EvidenceVault. Enforces:
 *
 *   - Agent address whitelisting (only one authorised hot wallet)
 *   - Nonce-based replay protection (each seal requires a fresh nonce)
 *   - Rate limiting (max seals per round window)
 *   - Admin separation (cold multisig controls agent rotation)
 *
 * The oracle never holds funds and cannot modify its own auth list.
 * Agent key compromise is bounded by the rate limit.
 *
 * @arc4 ARC-4 ABI compliant
 * @asif Agentic Security & Identity Framework aligned
 */
export class VerificationOracle extends Contract {
  // ── Global State ──────────────────────────────────────────────

  /** Cold multisig — the only address that can rotate the agent wallet */
  adminAddress = GlobalState<Address>()

  /** Hot wallet of the AI agent backend service */
  agentAddress = GlobalState<Address>()

  /** App ID of the EvidenceVault this oracle is authorised for */
  vaultAppId = GlobalState<uint64>()

  /** Total seals performed since deployment (monotonic) */
  sealCount = GlobalState<uint64>({ initialValue: 0n })

  /** Round at which the current rate-limit window started */
  windowStart = GlobalState<uint64>({ initialValue: 0n })

  /** Number of seals in the current window */
  windowSeals = GlobalState<uint64>({ initialValue: 0n })

  /** Max seals allowed per window (default: 100) */
  maxPerWindow = GlobalState<uint64>({ initialValue: 100n })

  /** Window size in rounds (default: 1000 rounds ≈ ~70 min on Algorand) */
  windowSize = GlobalState<uint64>({ initialValue: 1000n })

  // ── Box Storage ───────────────────────────────────────────────

  /**
   * Nonce tracking — prevents replay attacks.
   * Key: nonce (32 bytes, unique per invocation)
   * Value: round at which nonce was consumed
   */
  nonces = BoxMap<bytes, uint64>({ keyPrefix: 'n:' })

  // ── Lifecycle ─────────────────────────────────────────────────

  @abimethod({ onCreate: 'require' })
  create(admin: Address, agent: Address, vaultAppId: uint64): void {
    this.adminAddress.value = admin
    this.agentAddress.value = agent
    this.vaultAppId.value = vaultAppId
    this.windowStart.value = Global.round
    log('VerificationOracle created')
  }

  // ── Core Oracle Method ────────────────────────────────────────

  /**
   * Relay a verified truth score from the AI backend to EvidenceVault.
   *
   * Only the whitelisted agent wallet may call this. On success it:
   *   1. Consumes the nonce (replay protection)
   *   2. Updates the rate-limit window counter
   *   3. Sends an inner transaction to EvidenceVault.sealVerification()
   *   4. Emits an AVM audit log entry
   */
  @abimethod()
  relayVerification(
    nonce: bytes,
    claimId: bytes,
    truthScore: uint64,
    consistencyPct: uint64,
    reliabilityPct: uint64,
    contradictionPct: uint64,
    aiSummaryHash: bytes,
  ): void {
    // ── Auth ──
    assert(Txn.sender === this.agentAddress.value, 'Caller is not the authorised agent')

    // ── Replay protection ──
    assert(nonce.length === 32, 'Nonce must be 32 bytes')
    assert(!this.nonces(nonce).exists, 'Nonce already consumed (replay attack)')
    this.nonces(nonce).value = Global.round

    // ── Rate limiting ──
    this.refreshWindow()
    assert(
      this.windowSeals.value < this.maxPerWindow.value,
      'Rate limit exceeded for this window',
    )
    this.windowSeals.value = this.windowSeals.value + 1n

    // ── Input validation (fail fast before inner tx) ──
    assert(truthScore <= 100_000n, 'truthScore out of range')
    assert(consistencyPct <= 100_000n, 'consistencyPct out of range')
    assert(reliabilityPct <= 100_000n, 'reliabilityPct out of range')
    assert(contradictionPct <= 100_000n, 'contradictionPct out of range')

    // ── Inner transaction to EvidenceVault ──
    sendMethodCall<typeof EvidenceVaultStub.prototype.sealVerification>({
      applicationId: this.vaultAppId.value,
      methodArgs: [
        claimId,
        truthScore,
        consistencyPct,
        reliabilityPct,
        contradictionPct,
        aiSummaryHash,
      ],
    })

    // ── Audit log ──
    this.sealCount.value = this.sealCount.value + 1n
    log(
      'ORACLE_RELAY:nonce=' +
        nonce +
        ':claim=' +
        claimId +
        ':score=' +
        itob(truthScore) +
        ':seal#=' +
        itob(this.sealCount.value),
    )
  }

  // ── Admin Methods ─────────────────────────────────────────────

  /**
   * Rotate the agent hot wallet. Admin (cold multisig) only.
   * Use this immediately if the agent key is suspected compromised.
   */
  @abimethod()
  rotateAgent(newAgent: Address): void {
    assert(Txn.sender === this.adminAddress.value, 'Admin only')
    const oldAgent = this.agentAddress.value
    this.agentAddress.value = newAgent
    log('AGENT_ROTATED:old=' + oldAgent + ':new=' + newAgent)
  }

  /**
   * Update rate limit parameters. Admin only.
   * @param newMax    Maximum seals per window
   * @param newWindow Window size in rounds
   */
  @abimethod()
  setRateLimit(newMax: uint64, newWindow: uint64): void {
    assert(Txn.sender === this.adminAddress.value, 'Admin only')
    assert(newMax > 0n, 'maxPerWindow must be > 0')
    assert(newWindow > 0n, 'windowSize must be > 0')
    this.maxPerWindow.value = newMax
    this.windowSize.value = newWindow
    log('RATE_LIMIT_UPDATED:max=' + itob(newMax) + ':window=' + itob(newWindow))
  }

  /** Update vault reference. Admin only. */
  @abimethod()
  updateVaultRef(newVaultAppId: uint64): void {
    assert(Txn.sender === this.adminAddress.value, 'Admin only')
    this.vaultAppId.value = newVaultAppId
    log('VAULT_REF_UPDATED:' + itob(newVaultAppId))
  }

  // ── Read-only Methods ─────────────────────────────────────────

  @abimethod({ readonly: true })
  getStatus(): {
    sealCount: uint64
    windowSeals: uint64
    maxPerWindow: uint64
    agentAddress: Address
  } {
    return {
      sealCount: this.sealCount.value,
      windowSeals: this.windowSeals.value,
      maxPerWindow: this.maxPerWindow.value,
      agentAddress: this.agentAddress.value,
    }
  }

  // ── Internal Helpers ──────────────────────────────────────────

  /** Reset rate-limit window if a new window has started. */
  private refreshWindow(): void {
    const elapsed = Global.round - this.windowStart.value
    if (elapsed >= this.windowSize.value) {
      this.windowStart.value = Global.round
      this.windowSeals.value = 0n
    }
  }
}

/**
 * Stub used for sendMethodCall typing.
 * The actual EvidenceVault ABI is resolved at runtime via vaultAppId.
 */
abstract class EvidenceVaultStub extends Contract {
  abstract sealVerification(
    claimId: bytes,
    truthScore: uint64,
    consistencyPct: uint64,
    reliabilityPct: uint64,
    contradictionPct: uint64,
    aiSummaryHash: bytes,
  ): void
}
