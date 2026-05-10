/**
 * SlushyChartSnapshots ABI — copied verbatim from
 * slushy.trade/solidity/artifacts/SlushyChartSnapshots.json. The same
 * ABI is shipped on the slushy frontend; both must stay in sync with
 * the deployed contract.
 *
 * Updates: regenerate by re-running `npm run compile` in the solidity
 * dir and copy the artifact's `abi` field here.
 */

export const SLUSHY_CHART_SNAPSHOTS_ABI = [
  { inputs: [], name: 'EmptyMarket', type: 'error' },
  { inputs: [], name: 'EmptyUri', type: 'error' },
  { inputs: [], name: 'NoSnapshot', type: 'error' },
  { inputs: [], name: 'NotOwner', type: 'error' },
  { inputs: [], name: 'TokenDoesNotExist', type: 'error' },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'user',       type: 'address' },
      { indexed: true,  internalType: 'bytes32', name: 'marketHash', type: 'bytes32' },
      { indexed: true,  internalType: 'uint256', name: 'tokenId',    type: 'uint256' },
      { indexed: false, internalType: 'string',  name: 'market',     type: 'string'  },
    ],
    name: 'SnapshotBurned',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'user',       type: 'address' },
      { indexed: true,  internalType: 'bytes32', name: 'marketHash', type: 'bytes32' },
      { indexed: true,  internalType: 'uint256', name: 'tokenId',    type: 'uint256' },
      { indexed: false, internalType: 'string',  name: 'market',     type: 'string'  },
      { indexed: false, internalType: 'string',  name: 'uri',        type: 'string'  },
    ],
    name: 'SnapshotPublished',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from',    type: 'address' },
      { indexed: true, internalType: 'address', name: 'to',      type: 'address' },
      { indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'burn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '', type: 'address' },
      { internalType: 'string',  name: '', type: 'string'  },
    ],
    name: 'currentSnapshotOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: 'market', type: 'string' }],
    name: 'deleteForMarket',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    name: 'marketOf',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'name',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'string', name: 'market', type: 'string' },
      { internalType: 'string', name: 'uri',    type: 'string' },
    ],
    name: 'publish',
    outputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes4', name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
