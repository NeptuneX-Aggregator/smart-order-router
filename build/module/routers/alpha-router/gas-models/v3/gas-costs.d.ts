import { BigNumber } from '@ethersproject/bignumber';
import { ChainId } from '@uniswap/sdk-core';
import { V3Route } from '../../../router';
export declare const COST_PER_UNINIT_TICK: BigNumber;
export declare const BASE_SWAP_COST: (id: ChainId) => BigNumber;
export declare const COST_PER_INIT_TICK: (id: ChainId) => BigNumber;
export declare const COST_PER_HOP: (id: ChainId) => BigNumber;
export declare const SINGLE_HOP_OVERHEAD: (_id: ChainId) => BigNumber;
export declare const TOKEN_OVERHEAD: (id: ChainId, route: V3Route) => BigNumber;
