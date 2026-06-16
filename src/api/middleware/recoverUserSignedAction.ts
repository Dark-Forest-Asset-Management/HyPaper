/**
 * Recover the signer wallet from an HL **user-signed** /exchange action.
 *
 * User-signed actions (transfers, withdrawals, agent/builder approvals,
 * staking delegation, multi-sig conversion) use a DIFFERENT EIP-712 scheme
 * than L1 actions (recoverHlSigner.ts):
 *
 *   - domain: { name: "HyperliquidSignTransaction", version: "1",
 *               chainId: <int(action.signatureChainId)>,
 *               verifyingContract: 0x000…000 }
 *   - primaryType: "HyperliquidTransaction:<Name>"
 *   - message: the action object itself (signed fields named by the type;
 *              `type` and `signatureChainId` are present but not part of the
 *              signed struct, so ethers ignores them).
 *
 * The per-action field lists below are VERBATIM from the canonical HL Python
 * SDK `hyperliquid/utils/signing.py` (the same source recoverHlSigner.ts
 * cites for L1). Do not reorder or retype — the EIP-712 typeHash is
 * keccak256 of the exact "Name(type field,…)" string, so any drift recovers
 * a phantom address.
 *
 * Reference:
 *   https://github.com/hyperliquid-dex/hyperliquid-python-sdk
 *     → hyperliquid/utils/signing.py (sign_user_signed_action + helpers)
 */

import { ethers } from 'ethers';

interface HlSignature {
  r: string;
  s: string;
  v: number;
}

type Eip712Field = { name: string; type: string };

/** action.type → { primaryType, signed fields }. Verbatim from signing.py. */
const USER_SIGNED_SPECS: Record<string, { primaryType: string; fields: Eip712Field[] }> = {
  usdSend: {
    primaryType: 'HyperliquidTransaction:UsdSend',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  spotSend: {
    primaryType: 'HyperliquidTransaction:SpotSend',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'token', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  withdraw3: {
    primaryType: 'HyperliquidTransaction:Withdraw',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  usdClassTransfer: {
    primaryType: 'HyperliquidTransaction:UsdClassTransfer',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  sendAsset: {
    primaryType: 'HyperliquidTransaction:SendAsset',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'sourceDex', type: 'string' },
      { name: 'destinationDex', type: 'string' },
      { name: 'token', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'fromSubAccount', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  convertToMultiSigUser: {
    primaryType: 'HyperliquidTransaction:ConvertToMultiSigUser',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'signers', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  approveAgent: {
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  approveBuilderFee: {
    primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'maxFeeRate', type: 'string' },
      { name: 'builder', type: 'address' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  tokenDelegate: {
    primaryType: 'HyperliquidTransaction:TokenDelegate',
    fields: [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'validator', type: 'address' },
      { name: 'wei', type: 'uint64' },
      { name: 'isUndelegate', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
};

/** True if `type` is an HL user-signed action (vs an L1 action). */
export function isUserSignedActionType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(USER_SIGNED_SPECS, type);
}

/** Recover the signer (lowercased 0x address) from a user-signed action.
 *  Throws if the action type is unknown or the signature is malformed. */
export function recoverUserSignedAction(
  action: { type: string; signatureChainId?: string; [k: string]: unknown },
  signature: HlSignature,
): string {
  const spec = USER_SIGNED_SPECS[action.type];
  if (!spec) throw new Error(`Not a user-signed action type: ${action.type}`);
  if (typeof action.signatureChainId !== 'string') {
    throw new Error('user-signed action missing signatureChainId');
  }
  const chainId = parseInt(action.signatureChainId, 16);
  if (!Number.isFinite(chainId)) {
    throw new Error(`Invalid signatureChainId: ${action.signatureChainId}`);
  }

  const domain = {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const types = { [spec.primaryType]: spec.fields };

  // ethers reads only the fields named in `types`; extra keys on the action
  // (`type`, `signatureChainId`) are ignored. Signed values come straight
  // from the action exactly as the client sent it.
  const r = signature.r.startsWith('0x') ? signature.r.slice(2) : signature.r;
  const s = signature.s.startsWith('0x') ? signature.s.slice(2) : signature.s;
  const v = signature.v.toString(16).padStart(2, '0');
  const sigHex = `0x${r}${s}${v}`;

  const recovered = ethers.verifyTypedData(domain, types, action as Record<string, unknown>, sigHex);
  return recovered.toLowerCase();
}
