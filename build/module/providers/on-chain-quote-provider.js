import { BigNumber } from '@ethersproject/bignumber';
import { encodeMixedRouteToPath, MixedRouteSDK, Protocol, } from '@uniswap/router-sdk';
import { ChainId } from '@uniswap/sdk-core';
import { encodeRouteToPath } from '@uniswap/v3-sdk';
import retry from 'async-retry';
import _ from 'lodash';
import stats from 'stats-lite';
import { V2Route } from '../routers/router';
import { IMixedRouteQuoterV1__factory } from '../types/other/factories/IMixedRouteQuoterV1__factory';
import { IQuoterV2__factory } from '../types/v3/factories/IQuoterV2__factory';
import { metric, MetricLoggerUnit } from '../util';
import { MIXED_ROUTE_QUOTER_V1_ADDRESSES, QUOTER_V2_ADDRESSES, } from '../util/addresses';
import { log } from '../util/log';
import { routeToString } from '../util/routes';
export class BlockConflictError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'BlockConflictError';
    }
}
export class SuccessRateError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'SuccessRateError';
    }
}
export class ProviderBlockHeaderError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'ProviderBlockHeaderError';
    }
}
export class ProviderTimeoutError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'ProviderTimeoutError';
    }
}
/**
 * This error typically means that the gas used by the multicall has
 * exceeded the total call gas limit set by the node provider.
 *
 * This can be resolved by modifying BatchParams to request fewer
 * quotes per call, or to set a lower gas limit per quote.
 *
 * @export
 * @class ProviderGasError
 */
export class ProviderGasError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'ProviderGasError';
    }
}
const DEFAULT_BATCH_RETRIES = 2;
/**
 * Computes on chain quotes for swaps. For pure V3 routes, quotes are computed on-chain using
 * the 'QuoterV2' smart contract. For exactIn mixed and V2 routes, quotes are computed using the 'MixedRouteQuoterV1' contract
 * This is because computing quotes off-chain would require fetching all the tick data for each pool, which is a lot of data.
 *
 * To minimize the number of requests for quotes we use a Multicall contract. Generally
 * the number of quotes to fetch exceeds the maximum we can fit in a single multicall
 * while staying under gas limits, so we also batch these quotes across multiple multicalls.
 *
 * The biggest challenge with the quote provider is dealing with various gas limits.
 * Each provider sets a limit on the amount of gas a call can consume (on Infura this
 * is approximately 10x the block max size), so we must ensure each multicall does not
 * exceed this limit. Additionally, each quote on V3 can consume a large number of gas if
 * the pool lacks liquidity and the swap would cause all the ticks to be traversed.
 *
 * To ensure we don't exceed the node's call limit, we limit the gas used by each quote to
 * a specific value, and we limit the number of quotes in each multicall request. Users of this
 * class should set BatchParams such that multicallChunk * gasLimitPerCall is less than their node
 * providers total gas limit per call.
 *
 * @export
 * @class OnChainQuoteProvider
 */
export class OnChainQuoteProvider {
    /**
     * Creates an instance of OnChainQuoteProvider.
     *
     * @param chainId The chain to get quotes for.
     * @param provider The web 3 provider.
     * @param multicall2Provider The multicall provider to use to get the quotes on-chain.
     * Only supports the Uniswap Multicall contract as it needs the gas limitting functionality.
     * @param retryOptions The retry options for each call to the multicall.
     * @param batchParams The parameters for each batched call to the multicall.
     * @param gasErrorFailureOverride The gas and chunk parameters to use when retrying a batch that failed due to out of gas.
     * @param successRateFailureOverrides The parameters for retries when we fail to get quotes.
     * @param blockNumberConfig Parameters for adjusting which block we get quotes from, and how to handle block header not found errors.
     * @param [quoterAddressOverride] Overrides the address of the quoter contract to use.
     */
    constructor(chainId, provider, 
    // Only supports Uniswap Multicall as it needs the gas limitting functionality.
    multicall2Provider, retryOptions = {
        retries: DEFAULT_BATCH_RETRIES,
        minTimeout: 25,
        maxTimeout: 250,
    }, batchParams = {
        multicallChunk: 150,
        gasLimitPerCall: 1000000,
        quoteMinSuccessRate: 0.2,
    }, gasErrorFailureOverride = {
        gasLimitOverride: 1500000,
        multicallChunk: 100,
    }, successRateFailureOverrides = {
        gasLimitOverride: 1300000,
        multicallChunk: 110,
    }, blockNumberConfig = {
        baseBlockOffset: 0,
        rollback: { enabled: false },
    }, quoterAddressOverride) {
        this.chainId = chainId;
        this.provider = provider;
        this.multicall2Provider = multicall2Provider;
        this.retryOptions = retryOptions;
        this.batchParams = batchParams;
        this.gasErrorFailureOverride = gasErrorFailureOverride;
        this.successRateFailureOverrides = successRateFailureOverrides;
        this.blockNumberConfig = blockNumberConfig;
        this.quoterAddressOverride = quoterAddressOverride;
    }
    getQuoterAddress(useMixedRouteQuoter) {
        if (this.quoterAddressOverride) {
            return this.quoterAddressOverride;
        }
        const quoterAddress = useMixedRouteQuoter
            ? MIXED_ROUTE_QUOTER_V1_ADDRESSES[this.chainId]
            : QUOTER_V2_ADDRESSES[this.chainId];
        if (!quoterAddress) {
            throw new Error(`No address for the quoter contract on chain id: ${this.chainId}`);
        }
        return quoterAddress;
    }
    async getQuotesManyExactIn(amountIns, routes, providerConfig) {
        return this.getQuotesManyData(amountIns, routes, 'quoteExactInput', providerConfig);
    }
    async getQuotesManyExactOut(amountOuts, routes, providerConfig) {
        return this.getQuotesManyData(amountOuts, routes, 'quoteExactOutput', providerConfig);
    }
    async getQuotesManyData(amounts, routes, functionName, _providerConfig) {
        var _a;
        const useMixedRouteQuoter = routes.some((route) => route.protocol === Protocol.V2) ||
            routes.some((route) => route.protocol === Protocol.MIXED);
        /// Validate that there are no incorrect routes / function combinations
        this.validateRoutes(routes, functionName, useMixedRouteQuoter);
        let multicallChunk = this.batchParams.multicallChunk;
        let gasLimitOverride = this.batchParams.gasLimitPerCall;
        const { baseBlockOffset, rollback } = this.blockNumberConfig;
        // Apply the base block offset if provided
        const originalBlockNumber = await this.provider.getBlockNumber();
        const providerConfig = {
            ..._providerConfig,
            blockNumber: (_a = _providerConfig === null || _providerConfig === void 0 ? void 0 : _providerConfig.blockNumber) !== null && _a !== void 0 ? _a : originalBlockNumber + baseBlockOffset,
        };
        const inputs = _(routes)
            .flatMap((route) => {
            const encodedRoute = route.protocol === Protocol.V3
                ? encodeRouteToPath(route, functionName == 'quoteExactOutput' // For exactOut must be true to ensure the routes are reversed.
                )
                : encodeMixedRouteToPath(route instanceof V2Route
                    ? new MixedRouteSDK(route.pairs, route.input, route.output)
                    : route);
            const routeInputs = amounts.map((amount) => [
                encodedRoute,
                `0x${amount.quotient.toString(16)}`,
            ]);
            return routeInputs;
        })
            .value();
        const normalizedChunk = Math.ceil(inputs.length / Math.ceil(inputs.length / multicallChunk));
        const inputsChunked = _.chunk(inputs, normalizedChunk);
        let quoteStates = _.map(inputsChunked, (inputChunk) => {
            return {
                status: 'pending',
                inputs: inputChunk,
            };
        });
        log.info(`About to get ${inputs.length} quotes in chunks of ${normalizedChunk} [${_.map(inputsChunked, (i) => i.length).join(',')}] ${gasLimitOverride
            ? `with a gas limit override of ${gasLimitOverride}`
            : ''} and block number: ${await providerConfig.blockNumber} [Original before offset: ${originalBlockNumber}].`);
        let haveRetriedForSuccessRate = false;
        let haveRetriedForBlockHeader = false;
        let blockHeaderRetryAttemptNumber = 0;
        let haveIncrementedBlockHeaderFailureCounter = false;
        let blockHeaderRolledBack = false;
        let haveRetriedForBlockConflictError = false;
        let haveRetriedForOutOfGas = false;
        let haveRetriedForTimeout = false;
        let haveRetriedForUnknownReason = false;
        let finalAttemptNumber = 1;
        const expectedCallsMade = quoteStates.length;
        let totalCallsMade = 0;
        const { results: quoteResults, blockNumber, approxGasUsedPerSuccessCall, } = await retry(async (_bail, attemptNumber) => {
            haveIncrementedBlockHeaderFailureCounter = false;
            finalAttemptNumber = attemptNumber;
            const [success, failed, pending] = this.partitionQuotes(quoteStates);
            log.info(`Starting attempt: ${attemptNumber}.
          Currently ${success.length} success, ${failed.length} failed, ${pending.length} pending.
          Gas limit override: ${gasLimitOverride} Block number override: ${providerConfig.blockNumber}.`);
            quoteStates = await Promise.all(_.map(quoteStates, async (quoteState, idx) => {
                if (quoteState.status == 'success') {
                    return quoteState;
                }
                // QuoteChunk is pending or failed, so we try again
                const { inputs } = quoteState;
                try {
                    totalCallsMade = totalCallsMade + 1;
                    const results = await this.multicall2Provider.callSameFunctionOnContractWithMultipleParams({
                        address: this.getQuoterAddress(useMixedRouteQuoter),
                        contractInterface: useMixedRouteQuoter
                            ? IMixedRouteQuoterV1__factory.createInterface()
                            : IQuoterV2__factory.createInterface(),
                        functionName,
                        functionParams: inputs,
                        providerConfig,
                        additionalConfig: {
                            gasLimitPerCallOverride: gasLimitOverride,
                        },
                    });
                    const successRateError = this.validateSuccessRate(results.results, haveRetriedForSuccessRate);
                    if (successRateError) {
                        return {
                            status: 'failed',
                            inputs,
                            reason: successRateError,
                            results,
                        };
                    }
                    return {
                        status: 'success',
                        inputs,
                        results,
                    };
                }
                catch (err) {
                    // Error from providers have huge messages that include all the calldata and fill the logs.
                    // Catch them and rethrow with shorter message.
                    if (err.message.includes('header not found')) {
                        return {
                            status: 'failed',
                            inputs,
                            reason: new ProviderBlockHeaderError(err.message.slice(0, 500)),
                        };
                    }
                    if (err.message.includes('timeout')) {
                        return {
                            status: 'failed',
                            inputs,
                            reason: new ProviderTimeoutError(`Req ${idx}/${quoteStates.length}. Request had ${inputs.length} inputs. ${err.message.slice(0, 500)}`),
                        };
                    }
                    if (err.message.includes('out of gas')) {
                        return {
                            status: 'failed',
                            inputs,
                            reason: new ProviderGasError(err.message.slice(0, 500)),
                        };
                    }
                    return {
                        status: 'failed',
                        inputs,
                        reason: new Error(`Unknown error from provider: ${err.message.slice(0, 500)}`),
                    };
                }
            }));
            const [successfulQuoteStates, failedQuoteStates, pendingQuoteStates] = this.partitionQuotes(quoteStates);
            if (pendingQuoteStates.length > 0) {
                throw new Error('Pending quote after waiting for all promises.');
            }
            let retryAll = false;
            const blockNumberError = this.validateBlockNumbers(successfulQuoteStates, inputsChunked.length, gasLimitOverride);
            // If there is a block number conflict we retry all the quotes.
            if (blockNumberError) {
                retryAll = true;
            }
            const reasonForFailureStr = _.map(failedQuoteStates, (failedQuoteState) => failedQuoteState.reason.name).join(', ');
            if (failedQuoteStates.length > 0) {
                log.info(`On attempt ${attemptNumber}: ${failedQuoteStates.length}/${quoteStates.length} quotes failed. Reasons: ${reasonForFailureStr}`);
                for (const failedQuoteState of failedQuoteStates) {
                    const { reason: error } = failedQuoteState;
                    log.info({ error }, `[QuoteFetchError] Attempt ${attemptNumber}. ${error.message}`);
                    if (error instanceof BlockConflictError) {
                        if (!haveRetriedForBlockConflictError) {
                            metric.putMetric('QuoteBlockConflictErrorRetry', 1, MetricLoggerUnit.Count);
                            haveRetriedForBlockConflictError = true;
                        }
                        retryAll = true;
                    }
                    else if (error instanceof ProviderBlockHeaderError) {
                        if (!haveRetriedForBlockHeader) {
                            metric.putMetric('QuoteBlockHeaderNotFoundRetry', 1, MetricLoggerUnit.Count);
                            haveRetriedForBlockHeader = true;
                        }
                        // Ensure that if multiple calls fail due to block header in the current pending batch,
                        // we only count once.
                        if (!haveIncrementedBlockHeaderFailureCounter) {
                            blockHeaderRetryAttemptNumber =
                                blockHeaderRetryAttemptNumber + 1;
                            haveIncrementedBlockHeaderFailureCounter = true;
                        }
                        if (rollback.enabled) {
                            const { rollbackBlockOffset, attemptsBeforeRollback } = rollback;
                            if (blockHeaderRetryAttemptNumber >= attemptsBeforeRollback &&
                                !blockHeaderRolledBack) {
                                log.info(`Attempt ${attemptNumber}. Have failed due to block header ${blockHeaderRetryAttemptNumber - 1} times. Rolling back block number by ${rollbackBlockOffset} for next retry`);
                                providerConfig.blockNumber = providerConfig.blockNumber
                                    ? (await providerConfig.blockNumber) + rollbackBlockOffset
                                    : (await this.provider.getBlockNumber()) +
                                        rollbackBlockOffset;
                                retryAll = true;
                                blockHeaderRolledBack = true;
                            }
                        }
                    }
                    else if (error instanceof ProviderTimeoutError) {
                        if (!haveRetriedForTimeout) {
                            metric.putMetric('QuoteTimeoutRetry', 1, MetricLoggerUnit.Count);
                            haveRetriedForTimeout = true;
                        }
                    }
                    else if (error instanceof ProviderGasError) {
                        if (!haveRetriedForOutOfGas) {
                            metric.putMetric('QuoteOutOfGasExceptionRetry', 1, MetricLoggerUnit.Count);
                            haveRetriedForOutOfGas = true;
                        }
                        gasLimitOverride = this.gasErrorFailureOverride.gasLimitOverride;
                        multicallChunk = this.gasErrorFailureOverride.multicallChunk;
                        retryAll = true;
                    }
                    else if (error instanceof SuccessRateError) {
                        if (!haveRetriedForSuccessRate) {
                            metric.putMetric('QuoteSuccessRateRetry', 1, MetricLoggerUnit.Count);
                            haveRetriedForSuccessRate = true;
                            // Low success rate can indicate too little gas given to each call.
                            gasLimitOverride =
                                this.successRateFailureOverrides.gasLimitOverride;
                            multicallChunk =
                                this.successRateFailureOverrides.multicallChunk;
                            retryAll = true;
                        }
                    }
                    else {
                        if (!haveRetriedForUnknownReason) {
                            metric.putMetric('QuoteUnknownReasonRetry', 1, MetricLoggerUnit.Count);
                            haveRetriedForUnknownReason = true;
                        }
                    }
                }
            }
            if (retryAll) {
                log.info(`Attempt ${attemptNumber}. Resetting all requests to pending for next attempt.`);
                const normalizedChunk = Math.ceil(inputs.length / Math.ceil(inputs.length / multicallChunk));
                const inputsChunked = _.chunk(inputs, normalizedChunk);
                quoteStates = _.map(inputsChunked, (inputChunk) => {
                    return {
                        status: 'pending',
                        inputs: inputChunk,
                    };
                });
            }
            if (failedQuoteStates.length > 0) {
                // TODO: Work with Arbitrum to find a solution for making large multicalls with gas limits that always
                // successfully.
                //
                // On Arbitrum we can not set a gas limit for every call in the multicall and guarantee that
                // we will not run out of gas on the node. This is because they have a different way of accounting
                // for gas, that seperates storage and compute gas costs, and we can not cover both in a single limit.
                //
                // To work around this and avoid throwing errors when really we just couldn't get a quote, we catch this
                // case and return 0 quotes found.
                if ((this.chainId == ChainId.ARBITRUM_ONE ||
                    this.chainId == ChainId.ARBITRUM_GOERLI) &&
                    _.every(failedQuoteStates, (failedQuoteState) => failedQuoteState.reason instanceof ProviderGasError) &&
                    attemptNumber == this.retryOptions.retries) {
                    log.error(`Failed to get quotes on Arbitrum due to provider gas error issue. Overriding error to return 0 quotes.`);
                    return {
                        results: [],
                        blockNumber: BigNumber.from(0),
                        approxGasUsedPerSuccessCall: 0,
                    };
                }
                throw new Error(`Failed to get ${failedQuoteStates.length} quotes. Reasons: ${reasonForFailureStr}`);
            }
            const callResults = _.map(successfulQuoteStates, (quoteState) => quoteState.results);
            return {
                results: _.flatMap(callResults, (result) => result.results),
                blockNumber: BigNumber.from(callResults[0].blockNumber),
                approxGasUsedPerSuccessCall: stats.percentile(_.map(callResults, (result) => result.approxGasUsedPerSuccessCall), 100),
            };
        }, {
            retries: DEFAULT_BATCH_RETRIES,
            ...this.retryOptions,
        });
        const routesQuotes = this.processQuoteResults(quoteResults, routes, amounts);
        metric.putMetric('QuoteApproxGasUsedPerSuccessfulCall', approxGasUsedPerSuccessCall, MetricLoggerUnit.Count);
        metric.putMetric('QuoteNumRetryLoops', finalAttemptNumber - 1, MetricLoggerUnit.Count);
        metric.putMetric('QuoteTotalCallsToProvider', totalCallsMade, MetricLoggerUnit.Count);
        metric.putMetric('QuoteExpectedCallsToProvider', expectedCallsMade, MetricLoggerUnit.Count);
        metric.putMetric('QuoteNumRetriedCalls', totalCallsMade - expectedCallsMade, MetricLoggerUnit.Count);
        const [successfulQuotes, failedQuotes] = _(routesQuotes)
            .flatMap((routeWithQuotes) => routeWithQuotes[1])
            .partition((quote) => quote.quote != null)
            .value();
        log.info(`Got ${successfulQuotes.length} successful quotes, ${failedQuotes.length} failed quotes. Took ${finalAttemptNumber - 1} attempt loops. Total calls made to provider: ${totalCallsMade}. Have retried for timeout: ${haveRetriedForTimeout}`);
        return { routesWithQuotes: routesQuotes, blockNumber };
    }
    partitionQuotes(quoteStates) {
        const successfulQuoteStates = _.filter(quoteStates, (quoteState) => quoteState.status == 'success');
        const failedQuoteStates = _.filter(quoteStates, (quoteState) => quoteState.status == 'failed');
        const pendingQuoteStates = _.filter(quoteStates, (quoteState) => quoteState.status == 'pending');
        return [successfulQuoteStates, failedQuoteStates, pendingQuoteStates];
    }
    processQuoteResults(quoteResults, routes, amounts) {
        const routesQuotes = [];
        const quotesResultsByRoute = _.chunk(quoteResults, amounts.length);
        const debugFailedQuotes = [];
        for (let i = 0; i < quotesResultsByRoute.length; i++) {
            const route = routes[i];
            const quoteResults = quotesResultsByRoute[i];
            const quotes = _.map(quoteResults, (quoteResult, index) => {
                const amount = amounts[index];
                if (!quoteResult.success) {
                    const percent = (100 / amounts.length) * (index + 1);
                    const amountStr = amount.toFixed(Math.min(amount.currency.decimals, 2));
                    const routeStr = routeToString(route);
                    debugFailedQuotes.push({
                        route: routeStr,
                        percent,
                        amount: amountStr,
                    });
                    return {
                        amount,
                        quote: null,
                        sqrtPriceX96AfterList: null,
                        gasEstimate: null,
                        initializedTicksCrossedList: null,
                    };
                }
                return {
                    amount,
                    quote: quoteResult.result[0],
                    sqrtPriceX96AfterList: quoteResult.result[1],
                    initializedTicksCrossedList: quoteResult.result[2],
                    gasEstimate: quoteResult.result[3],
                };
            });
            routesQuotes.push([route, quotes]);
        }
        // For routes and amounts that we failed to get a quote for, group them by route
        // and batch them together before logging to minimize number of logs.
        const debugChunk = 80;
        _.forEach(_.chunk(debugFailedQuotes, debugChunk), (quotes, idx) => {
            const failedQuotesByRoute = _.groupBy(quotes, (q) => q.route);
            const failedFlat = _.mapValues(failedQuotesByRoute, (f) => _(f)
                .map((f) => `${f.percent}%[${f.amount}]`)
                .join(','));
            log.info({
                failedQuotes: _.map(failedFlat, (amounts, routeStr) => `${routeStr} : ${amounts}`),
            }, `Failed on chain quotes for routes Part ${idx}/${Math.ceil(debugFailedQuotes.length / debugChunk)}`);
        });
        return routesQuotes;
    }
    validateBlockNumbers(successfulQuoteStates, totalCalls, gasLimitOverride) {
        if (successfulQuoteStates.length <= 1) {
            return null;
        }
        const results = _.map(successfulQuoteStates, (quoteState) => quoteState.results);
        const blockNumbers = _.map(results, (result) => result.blockNumber);
        const uniqBlocks = _(blockNumbers)
            .map((blockNumber) => blockNumber.toNumber())
            .uniq()
            .value();
        if (uniqBlocks.length == 1) {
            return null;
        }
        /* if (
          uniqBlocks.length == 2 &&
          Math.abs(uniqBlocks[0]! - uniqBlocks[1]!) <= 1
        ) {
          return null;
        } */
        return new BlockConflictError(`Quotes returned from different blocks. ${uniqBlocks}. ${totalCalls} calls were made with gas limit ${gasLimitOverride}`);
    }
    validateSuccessRate(allResults, haveRetriedForSuccessRate) {
        const numResults = allResults.length;
        const numSuccessResults = allResults.filter((result) => result.success).length;
        const successRate = (1.0 * numSuccessResults) / numResults;
        const { quoteMinSuccessRate } = this.batchParams;
        if (successRate < quoteMinSuccessRate) {
            if (haveRetriedForSuccessRate) {
                log.info(`Quote success rate still below threshold despite retry. Continuing. ${quoteMinSuccessRate}: ${successRate}`);
                return;
            }
            return new SuccessRateError(`Quote success rate below threshold of ${quoteMinSuccessRate}: ${successRate}`);
        }
    }
    /**
     * Throw an error for incorrect routes / function combinations
     * @param routes Any combination of V3, V2, and Mixed routes.
     * @param functionName
     * @param useMixedRouteQuoter true if there are ANY V2Routes or MixedRoutes in the routes parameter
     */
    validateRoutes(routes, functionName, useMixedRouteQuoter) {
        /// We do not send any V3Routes to new qutoer becuase it is not deployed on chains besides mainnet
        if (routes.some((route) => route.protocol === Protocol.V3) &&
            useMixedRouteQuoter) {
            throw new Error(`Cannot use mixed route quoter with V3 routes`);
        }
        /// We cannot call quoteExactOutput with V2 or Mixed routes
        if (functionName === 'quoteExactOutput' && useMixedRouteQuoter) {
            throw new Error('Cannot call quoteExactOutput with V2 or Mixed routes');
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib24tY2hhaW4tcXVvdGUtcHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvcHJvdmlkZXJzL29uLWNoYWluLXF1b3RlLXByb3ZpZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUVyRCxPQUFPLEVBQ0wsc0JBQXNCLEVBQ3RCLGFBQWEsRUFDYixRQUFRLEdBQ1QsTUFBTSxxQkFBcUIsQ0FBQztBQUM3QixPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDNUMsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDcEQsT0FBTyxLQUFrQyxNQUFNLGFBQWEsQ0FBQztBQUM3RCxPQUFPLENBQUMsTUFBTSxRQUFRLENBQUM7QUFDdkIsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBRS9CLE9BQU8sRUFBYyxPQUFPLEVBQVcsTUFBTSxtQkFBbUIsQ0FBQztBQUNqRSxPQUFPLEVBQUUsNEJBQTRCLEVBQUUsTUFBTSx1REFBdUQsQ0FBQztBQUNyRyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSwwQ0FBMEMsQ0FBQztBQUM5RSxPQUFPLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ25ELE9BQU8sRUFDTCwrQkFBK0IsRUFDL0IsbUJBQW1CLEdBQ3BCLE1BQU0sbUJBQW1CLENBQUM7QUFFM0IsT0FBTyxFQUFFLEdBQUcsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNsQyxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUErQi9DLE1BQU0sT0FBTyxrQkFBbUIsU0FBUSxLQUFLO0lBQTdDOztRQUNTLFNBQUksR0FBRyxvQkFBb0IsQ0FBQztJQUNyQyxDQUFDO0NBQUE7QUFDRCxNQUFNLE9BQU8sZ0JBQWlCLFNBQVEsS0FBSztJQUEzQzs7UUFDUyxT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