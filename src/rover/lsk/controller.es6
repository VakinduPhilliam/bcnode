/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import type { Logger } from 'winston'
const { inspect, promisify } = require('util')
const LRUCache = require('lru-cache')
const lisk = require('lisk-js')
const grpc = require('grpc')

const string = require('../../utils/strings.js')
const { Block } = require('../../protos/block_pb')
const { CollectorClient } = require('../../protos/collector_grpc_pb')
const config = require('../../../config/config')

const LISK_OPTIONS = {
  ssl: true,
  randomPeer: true,
  testnet: false,
  port: '443',
  bannedPeers: []
}

type LiskBlock = { // eslint-disable-line no-undef
  id: string,
  height: number,
  previousBlock: string,
  transactions: Object[],
  totalFee: number,
  payloadHash: string,
  payloadLength: number,
  generatorId: string,
  generatorPublicKey: string,
  blockSignature: string,
  confirmations: number,
  totalForged: number,
  timestamp: string,
  version: string,
}

const getMerkleRoot = (txs) => txs.reduce((all, tx) => string.blake2b(all + tx.id), '')

const getLastHeight = (): Promise<number> => {
  const response = lisk.api(LISK_OPTIONS).sendRequest('blocks/getHeight')
  return response.then(d => d.height)
}

const getBlock = (height: number): Promise<LiskBlock> => { // TODO type for block
  return lisk.api(LISK_OPTIONS).sendRequest('blocks', { height }).then(response => response.blocks.pop())
}

const getTransactionsForBlock = (blockId: string): Promise<Object[]> => {
  return lisk.api(LISK_OPTIONS).sendRequest('transactions', { blockId }).then(response => response.transactions)
}

const _createUnifiedBlock = (block): Block => {
  // TODO return Block as message
  const obj = {}

  obj.blockNumber = block.height
  obj.prevHash = block.previousBlock
  obj.blockHash = block.id
  obj.root = getMerkleRoot(block.transactions)
  obj.fee = block.totalFee
  obj.size = block.payloadLength
  obj.payloadHash = block.payloadHash
  obj.generator = block.generatorId
  obj.generatorPublicKey = block.generatorPublicKey
  obj.blockSignature = block.blockSignature
  obj.confirmations = block.confirmations
  obj.totalForged = block.totalForged
  obj.timestamp = block.timestamp
  obj.version = block.version
  obj.transactions = block.transactions.reduce(function (all, t) {
    const tx = {
      txHash: t.id,
      // inputs: t.inputs,
      // outputs: t.outputs,
      marked: false
    }
    all.push(tx)
    return all
  }, [])

  return obj
}

export default class Controller {
  /* eslint-disable no-undef */
  _dpt: bool;
  _interfaces: Object[];
  _blockCache: LRUCache;
  _otherCache: LRUCache;
  _service: CollectorClient;
  _logger: Logger;
  _runLoop: boolean;
  _intervalDescriptor: IntervalID;
  /* eslint-enable */

  constructor (logger: Logger) {
    this._dpt = false
    this._interfaces = []
    this._logger = logger
    this._blockCache = new LRUCache({
      max: 500,
      maxAge: 1000 * 60 * 60
    })
    this._otherCache = new LRUCache(50)
    this._runLoop = true

    this._service = new CollectorClient(`${config.grpc.host}:${config.grpc.port}`, grpc.credentials.createInsecure())
  }

  init (config: Object) {
    this._logger.debug('LSK rover: initialized')

    const cycle = () => {
      this._logger.info('LSK rover: trying to get new block')

      return getLastHeight().then(lastHeight => {
        this._logger.debug(`LSK rover: got lastHeight: "${lastHeight}"`)

        getBlock(lastHeight).then(lastBlock => {
          this._logger.debug(`LSK rover: got lastBlock: "${inspect(lastHeight)}"`)

          if (!this._blockCache.has(lastBlock.id)) {
            this._blockCache.set(lastBlock.id, true)
            this._logger.debug(`LSK rover: collected new block with id: ${inspect(lastBlock.id)}`)

            getTransactionsForBlock(lastBlock.id).then(transactions => {
              lastBlock.transactions = transactions
              this._logger.debug(`LSK rover: successfuly got ${transactions.length} transactions for block ${inspect(lastBlock.id)}`)

              const unifiedBlock = _createUnifiedBlock(lastBlock)
              this._logger.debug(`LSK rover: created unified block: ${inspect(unifiedBlock, {depth: 0})}`)
              // TODO remove after following is uncommented
              this._logger.info(`LSK rover: publishing new block to engine`)
              // TODO uncomment after Block proto msg is stabilized
              // promisify(this._service.collectBlock)(unifiedBlock).then(() => {
              //   this._logger.info(`LSK rover: publishing new block to engine`)
              // })
            })
          }
        })
      }).catch(e => {
        this._logger.error(`LSK rover: error while getting new block, err: ${inspect(e)}`)
      })
    }

    this._logger.info('LSK rover tick')
    this._intervalDescriptor = setInterval(() => {
      cycle().then(() => {
        this._logger.info('LSK rover tick')
      })
    }, 2000)

    // setInterval(function () {
    //  lisk.api(liskOptions).getPeersList({}, function (error, success, response) {
    //    if (error) {
    //      console.trace(error)
    //    } else {
    //      var t = response.peers.reduce(function (all, a) {
    //        if (all[a.height] == undefined) {
    //          all[a.height] = 1
    //        } else {
    //          all[a.height]++
    //        }
    //        return all
    //      }, {})

    //      var tp = Object.keys(t).sort(function (a, b) {
    //        if (t[a] > t[b]) {
    //          return -1
    //        }
    //        if (t[a] < t[b]) {
    //          return 1
    //        }
    //        return 0
    //      })

    //      log.info('peer sample: ' + response.peers.length)
    //      log.info('probable lsk block heigh ' + tp[0])
    //    }
    //  })
    // }, 60000)
  }

  close () {
    this._intervalDescriptor && clearInterval(this._intervalDescriptor)
    // this._interfaces.map(function (c) {
    //   c.close()
    // })
  }
}