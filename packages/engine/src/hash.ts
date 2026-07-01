/**
 * @marchward/engine — Cryptographic hash chaining for tamper-evident audit trail
 *
 * Every decision record is linked to the previous one via SHA-256 hashes.
 * If any record is modified after the fact, the chain breaks — making
 * tampering detectable.
 */

import { createHash } from "node:crypto";
import type { AuthorizeRequest, IntegrityRecord } from "./types.js";

/** The genesis hash used for the very first record in the chain. */
export const GENESIS_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Compute a SHA-256 hash of the given data, returning a prefixed hex string.
 * Deterministic: same input always produces same output.
 */
export function sha256(data: string): string {
  const hash = createHash("sha256").update(data, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Compute a deterministic hash of the authorization request inputs.
 * This proves the decision was made against a specific, unmodified request.
 *
 * We sort keys to ensure deterministic serialization regardless of
 * property insertion order.
 */
export function hashInputs(request: AuthorizeRequest): string {
  const canonical = JSON.stringify(request, Object.keys(request).sort());
  return sha256(canonical);
}

/**
 * Compute the record hash for a decision record.
 * Includes the decision ID, inputs hash, evaluation result, and prev hash
 * to form the chain link.
 */
export function hashRecord(params: {
  decisionId: string;
  inputsHash: string;
  decision: string;
  reasonCodes: string[];
  prevHash: string;
  timestamp: string;
}): string {
  const canonical = JSON.stringify({
    decisionId: params.decisionId,
    inputsHash: params.inputsHash,
    decision: params.decision,
    reasonCodes: params.reasonCodes.slice().sort(),
    prevHash: params.prevHash,
    timestamp: params.timestamp,
  });
  return sha256(canonical);
}

/**
 * Build a complete integrity record for a decision.
 * This is the final step before persisting — it links the new record
 * into the hash chain.
 */
export function buildIntegrity(params: {
  decisionId: string;
  request: AuthorizeRequest;
  decision: string;
  reasonCodes: string[];
  prevHash: string;
  timestamp: string;
}): IntegrityRecord {
  const inputsHash = hashInputs(params.request);
  const recordHash = hashRecord({
    decisionId: params.decisionId,
    inputsHash,
    decision: params.decision,
    reasonCodes: params.reasonCodes,
    prevHash: params.prevHash,
    timestamp: params.timestamp,
  });

  return {
    prevHash: params.prevHash,
    recordHash,
    inputsHash,
  };
}

/**
 * Verify that a record's hash matches its contents.
 * Used to detect tampering in the audit trail.
 */
export function verifyRecordIntegrity(params: {
  decisionId: string;
  inputsHash: string;
  decision: string;
  reasonCodes: string[];
  prevHash: string;
  timestamp: string;
  expectedHash: string;
}): boolean {
  const computed = hashRecord({
    decisionId: params.decisionId,
    inputsHash: params.inputsHash,
    decision: params.decision,
    reasonCodes: params.reasonCodes,
    prevHash: params.prevHash,
    timestamp: params.timestamp,
  });
  return computed === params.expectedHash;
}

/**
 * Verify a chain of decision records is intact.
 * Returns the index of the first broken link, or -1 if chain is valid.
 */
export function verifyChain(
  records: Array<{
    integrity: IntegrityRecord;
    decisionId: string;
    decision: string;
    reasonCodes: string[];
    timestamp: string;
  }>
): number {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const expectedPrevHash = i === 0
      ? GENESIS_HASH
      : records[i - 1].integrity.recordHash;

    // Check chain link
    if (record.integrity.prevHash !== expectedPrevHash) {
      return i;
    }

    // Check record integrity
    const valid = verifyRecordIntegrity({
      decisionId: record.decisionId,
      inputsHash: record.integrity.inputsHash,
      decision: record.decision,
      reasonCodes: record.reasonCodes,
      prevHash: record.integrity.prevHash,
      timestamp: record.timestamp,
      expectedHash: record.integrity.recordHash,
    });

    if (!valid) {
      return i;
    }
  }

  return -1; // Chain is valid
}
