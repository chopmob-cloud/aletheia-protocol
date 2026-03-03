# Aletheia — AI-Verified Truth Layer on Algorand

> *ἀλήθεια* · Truth should be immutable.

**Live site → [aletheia.ilc-n.xyz](https://aletheia.ilc-n.xyz)**

A decentralised AI fact-verification and micro-governance platform. Community decisions — anchored on-chain, beyond doubt.

---

## What It Does

- Users submit a claim, document, or policy proposal
- An AI verification engine cross-checks sources, detects contradictions, and generates a probabilistic **Truth Score**
- Algorand smart contracts seal the evidence, enforce transparent voting rules, and record an immutable community resolution

## Smart Contracts

| Contract | Role | File |
|---|---|---|
| `EvidenceVault` | Core claim & score storage | [`contracts/evidence_vault.algo.ts`](contracts/evidence_vault.algo.ts) |
| `VerificationOracle` | ASIF-constrained AI agent bridge | [`contracts/verification_oracle.algo.ts`](contracts/verification_oracle.algo.ts) |
| `GovernanceRoom` | Community voting & resolution | [`contracts/governance_room.algo.ts`](contracts/governance_room.algo.ts) |

Built with **AlgoKit · PuyaTs · ARC-4 · ARC-56 · ASIF**

## Pitch Deck

[Download Aletheia_Pitch_Deck.pptx](assets/Aletheia_Pitch_Deck.pptx) — 10 slides covering the problem, protocol, architecture, market, and roadmap.

## Status

Exploring · v0.1 · Architecture designed · AlgoKit scaffold ready

## License

MIT
