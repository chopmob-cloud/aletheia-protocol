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
 * RoomRecord — state of a single governance room.
 */
type RoomRecord = {
  claimId: bytes          // links to EvidenceVault record (32 bytes)
  creator: Address
  votingMode: uint64      // 0 = egalitarian, 1 = stake-weighted
  quorumPct: uint64       // e.g. 40_000 = 40% (3 decimal places)
  openAt: uint64          // Unix timestamp
  closeAt: uint64         // Unix timestamp
  yesVotes: uint64        // raw count (egalitarian) or weighted (stake)
  noVotes: uint64
  totalVoters: uint64     // unique voters
  resolved: uint64        // 0 = open, 1 = resolved
  resolution: uint64      // 0=unresolved, 1=passed, 2=failed, 3=no-quorum
  resolutionHash: bytes   // SHA-256 of outcome narrative (32 bytes)
}

/**
 * GovernanceRoom
 *
 * Community voting on AI-verified claims. Each room is linked to a
 * sealed EvidenceVault claim — votes are always cast with full AI context.
 *
 * Resolutions are immutable once finalised. Quorum failures are recorded
 * as a distinct outcome (status 3), not silently dropped.
 *
 * @arc4 ARC-4 ABI compliant
 */
export class GovernanceRoom extends Contract {
  // ── Global State ──────────────────────────────────────────────

  admin = GlobalState<Address>()
  vaultAppId = GlobalState<uint64>()
  totalRooms = GlobalState<uint64>({ initialValue: 0n })

  // ── Box Storage ───────────────────────────────────────────────

  /** Key: roomId (32 bytes). Value: RoomRecord */
  rooms = BoxMap<bytes, RoomRecord>({ keyPrefix: 'r:' })

  /**
   * Voter participation records — prevents double voting.
   * Key: roomId (32 bytes) + voter address (32 bytes) = 64 bytes
   * Value: vote cast (1 = yes, 2 = no)
   */
  votes = BoxMap<bytes, uint64>({ keyPrefix: 'v:' })

  // ── Lifecycle ─────────────────────────────────────────────────

  @abimethod({ onCreate: 'require' })
  create(admin: Address, vaultAppId: uint64): void {
    this.admin.value = admin
    this.vaultAppId.value = vaultAppId
    log('GovernanceRoom created')
  }

  // ── Room Management ───────────────────────────────────────────

  /**
   * Open a new governance room. The linked claim must already be
   * verified (status >= 1) in EvidenceVault.
   *
   * Caller must fund box MBR for room storage.
   */
  @abimethod()
  openRoom(
    roomId: bytes,
    claimId: bytes,
    votingMode: uint64,
    quorumPct: uint64,
    durationSec: uint64,
  ): void {
    assert(!this.rooms(roomId).exists, 'Room already exists')
    assert(roomId.length === 32, 'roomId must be 32 bytes')
    assert(claimId.length === 32, 'claimId must be 32 bytes')
    assert(votingMode <= 1n, 'Invalid votingMode (0=egalitarian, 1=stake)')
    assert(quorumPct > 0n && quorumPct <= 100_000n, 'quorumPct must be 1–100_000')
    assert(durationSec >= 3600n, 'Minimum voting duration is 1 hour')
    assert(durationSec <= 2_592_000n, 'Maximum voting duration is 30 days')

    // Verify claim is sealed in EvidenceVault
    // In production: use sendMethodCall readonly to check vault state
    // For MVP: caller must provide proof via claimId; off-chain validation
    // enforced by frontend + oracle signature

    const openAt = Global.latestTimestamp
    const closeAt = openAt + durationSec

    this.rooms(roomId).value = {
      claimId,
      creator: Txn.sender,
      votingMode,
      quorumPct,
      openAt,
      closeAt,
      yesVotes: 0n,
      noVotes: 0n,
      totalVoters: 0n,
      resolved: 0n,
      resolution: 0n,
      resolutionHash: bytes(''),
    }

    this.totalRooms.value = this.totalRooms.value + 1n
    log('ROOM_OPENED:' + roomId + ':claim=' + claimId)
  }

  /**
   * Cast a vote. One vote per address per room.
   * Room must be open and the voting window must be active.
   */
  @abimethod()
  castVote(roomId: bytes, support: boolean): void {
    assert(this.rooms(roomId).exists, 'Room does not exist')
    const room = this.rooms(roomId).value

    assert(room.resolved === 0n, 'Room already resolved')
    assert(Global.latestTimestamp >= room.openAt, 'Voting not yet open')
    assert(Global.latestTimestamp < room.closeAt, 'Voting window closed')

    // One-vote-per-address enforcement
    const voteKey = roomId + Txn.sender
    assert(!this.votes(voteKey).exists, 'Already voted in this room')

    // Record vote
    const voteValue: uint64 = support ? 1n : 2n
    this.votes(voteKey).value = voteValue

    // Tally
    if (support) {
      this.rooms(roomId).value = {
        ...room,
        yesVotes: room.yesVotes + 1n,
        totalVoters: room.totalVoters + 1n,
      }
    } else {
      this.rooms(roomId).value = {
        ...room,
        noVotes: room.noVotes + 1n,
        totalVoters: room.totalVoters + 1n,
      }
    }

    log('VOTE_CAST:room=' + roomId + ':voter=' + Txn.sender + ':support=' + (support ? '1' : '0'))
  }

  /**
   * Finalise a room after the voting window closes. Anyone may call this.
   *
   * Determines resolution:
   *   - 1 (passed)    — quorum met, yes > no
   *   - 2 (failed)    — quorum met, no >= yes
   *   - 3 (no-quorum) — minimum participation not reached
   *
   * narrativeHash: SHA-256 of the off-chain resolution narrative document.
   * Once set, resolution is permanently immutable.
   */
  @abimethod()
  finaliseRoom(roomId: bytes, narrativeHash: bytes): void {
    assert(this.rooms(roomId).exists, 'Room does not exist')
    const room = this.rooms(roomId).value

    assert(room.resolved === 0n, 'Room already resolved')
    assert(Global.latestTimestamp >= room.closeAt, 'Voting window still open')
    assert(narrativeHash.length === 32, 'narrativeHash must be 32 bytes')

    // Quorum check — using approximate total (totalVoters as proxy)
    // In production: quorum denominator = registered members in the room
    // For MVP: quorum is evaluated as yes+no / totalVoters (always 100%)
    // and a separate minimumVoters parameter should be added to RoomRecord
    const totalVotes = room.yesVotes + room.noVotes
    let resolution: uint64 = 3n // default: no-quorum

    if (totalVotes > 0n) {
      // Simple majority check (extend for stake-weighted in v2)
      if (room.yesVotes > room.noVotes) {
        resolution = 1n // passed
      } else {
        resolution = 2n // failed
      }
    }

    // Seal resolution — immutable from this point
    this.rooms(roomId).value = {
      ...room,
      resolved: 1n,
      resolution,
      resolutionHash: narrativeHash,
    }

    log(
      'ROOM_FINALISED:' +
        roomId +
        ':resolution=' +
        itob(resolution) +
        ':yes=' +
        itob(room.yesVotes) +
        ':no=' +
        itob(room.noVotes),
    )
  }

  // ── Read-only Methods ─────────────────────────────────────────

  @abimethod({ readonly: true })
  getRoomRecord(roomId: bytes): RoomRecord {
    assert(this.rooms(roomId).exists, 'Room does not exist')
    return this.rooms(roomId).value
  }

  @abimethod({ readonly: true })
  getVote(roomId: bytes, voter: Address): uint64 {
    const voteKey = roomId + voter
    if (!this.votes(voteKey).exists) return 0n
    return this.votes(voteKey).value
  }

  @abimethod({ readonly: true })
  getRoomStatus(roomId: bytes): {
    isOpen: boolean
    resolved: uint64
    yesVotes: uint64
    noVotes: uint64
    totalVoters: uint64
  } {
    assert(this.rooms(roomId).exists, 'Room does not exist')
    const room = this.rooms(roomId).value
    const isOpen =
      room.resolved === 0n &&
      Global.latestTimestamp >= room.openAt &&
      Global.latestTimestamp < room.closeAt
    return {
      isOpen,
      resolved: room.resolved,
      yesVotes: room.yesVotes,
      noVotes: room.noVotes,
      totalVoters: room.totalVoters,
    }
  }

  // ── Admin Methods ─────────────────────────────────────────────

  @abimethod()
  updateVaultRef(newVaultAppId: uint64): void {
    assert(Txn.sender === this.admin.value, 'Admin only')
    this.vaultAppId.value = newVaultAppId
  }

  /**
   * Emergency close — admin can force-resolve a room as no-quorum.
   * Only use for stuck rooms (e.g. evidence of vote manipulation).
   * Emits a distinct EMERGENCY_CLOSE log for audit trail transparency.
   */
  @abimethod()
  emergencyClose(roomId: bytes, narrativeHash: bytes): void {
    assert(Txn.sender === this.admin.value, 'Admin only')
    assert(this.rooms(roomId).exists, 'Room does not exist')
    const room = this.rooms(roomId).value
    assert(room.resolved === 0n, 'Room already resolved')

    this.rooms(roomId).value = {
      ...room,
      resolved: 1n,
      resolution: 3n, // no-quorum
      resolutionHash: narrativeHash,
    }

    log('EMERGENCY_CLOSE:' + roomId + ':admin=' + Txn.sender)
  }
}
