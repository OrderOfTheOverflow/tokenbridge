const Web3 = require('web3');
const fs = require('fs');
const abiBridge = require('../abis/Bridge.json');
const abiMultiSig = require('../abis/MultiSig.json');
const TransactionSender = require('../services/TransactionSender');
const CustomError = require('./CustomError');

module.exports = class Federator {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;

        this.mainWeb3 = new Web3(config.mainchain.host);
        this.sideWeb3 = new Web3(config.sidechain.host);

        this.mainBridgeContract = new this.mainWeb3.eth.Contract(abiBridge, this.config.mainchain.bridge);
        this.sideBridgeContract = new this.sideWeb3.eth.Contract(abiBridge, this.config.sidechain.bridge);
        this.multiSigContract = new this.sideWeb3.eth.Contract(abiMultiSig, this.config.sidechain.multisig);

        this.transactionSender = new TransactionSender(this.sideWeb3, this.logger);

        this.lastBlockPath = `${config.storagePath || __dirname}/lastBlock.txt`;
        this.lastTxCountPath = `${config.storagePath || __dirname}/lastTxCount.txt`;
    }

    async run() {
        try {
            const currentBlock = await this.mainWeb3.eth.getBlockNumber();
            const toBlock = currentBlock - this.config.confirmations || 0;
            this.logger.info('Running to Block', toBlock);

            if (toBlock <= 0) {
                return false;
            }

            let fromBlock = null;
            try {
                fromBlock = fs.readFileSync(this.lastBlockPath, 'utf8');
                fromBlock++;
            } catch(err) {
                fromBlock = this.config.fromBlock || 0;
            }
            this.logger.debug('Running from Block', fromBlock);

            const logs = await this.mainBridgeContract.getPastEvents('Cross', {
                fromBlock,
                toBlock,
                filter: { _tokenAddress: this.config.mainchain.testToken }
            });
            this.logger.info(`Found ${logs.length} logs`);

            await this._confirmPendingTransactions();
            await this._processLogs(logs);
        } catch (err) {
            this.logger.error(new CustomError('Exception Running Federator', err));
            process.exit();
        }
    }

    async _confirmPendingTransactions() {
        const transactionSender = new TransactionSender(this.sideWeb3, this.logger);
        const from = await transactionSender.getAddress(this.config.privateKey);

        let fromTransactionCount = 0;
        try {
            fromTransactionCount = fs.readFileSync(this.lastTxCountPath, 'utf8');
        } catch(err) {
            fromTransactionCount = 0;
        }

        let currentTransactionCount = await this.multiSigContract.methods.transactionCount().call();
        this.logger.info(`Checking pending transaction from ${fromTransactionCount} to ${currentTransactionCount}`);

        let pendingTransactions = await this.multiSigContract.methods.getTransactionIds(fromTransactionCount, currentTransactionCount, true, false).call();

        if (pendingTransactions && pendingTransactions.length) {
            for (let pending of pendingTransactions) {
                let wasConfirmed = await this.multiSigContract.methods.confirmations(pending, from).call();
                if (!wasConfirmed) {
                    this.logger.info(`Confirm MultiSig Tx ${pending}`)
                    let txData = await this.multiSigContract.methods.confirmTransaction(pending).encodeABI();
                    await transactionSender.sendTransaction(this.multiSigContract.options.address, txData, 0, this.config.privateKey);
                }
            }
        }

        this._saveProgress(this.lastTxCountPath, currentTransactionCount);
    }

    async _processLogs(logs) {
        let lastBlockNumber = null;

        for(let log of logs) {
            this.logger.info('Processing event log:', log);

            const { returnValues } = log;
            const originalReceiver = returnValues._to;
            const receiver = await this.mainBridgeContract.methods.getMappedAddress(originalReceiver).call();

            let wasProcessed = await this.sideBridgeContract.methods.transactionWasProcessed(
                log.blockNumber,
                log.blockHash,
                log.transactionHash,
                receiver,
                log.returnValues._amount,
                log.id
            ).call();

            console.log('was processed? ', wasProcessed)

            if (!wasProcessed) {
                this.logger.info('Voting tx ', log.transactionHash);
                await this._voteTransaction(log, receiver);
            }

            lastBlockNumber = log.blockNumber;
        }

        this._saveProgress(this.lastBlockPath, lastBlockNumber);
    }

    async _voteTransaction(log, receiver) {
        const transactionSender = new TransactionSender(this.sideWeb3, this.logger);

        const { _amount: amount, _symbol: symbol} = log.returnValues ;
        this.logger.info(`Transfering ${amount} to sidechain bridge ${this.sideBridgeContract.options.address}`);

        let txTransferData = this.sideBridgeContract.methods.acceptTransfer(
            this.config.sidechain.testToken,
            receiver,
            amount,
            symbol,
            log.blockNumber,
            log.blockHash,
            log.transactionHash,
            log.id
        ).encodeABI();

        let txData = this.multiSigContract.methods.submitTransaction(this.sideBridgeContract.options.address, 0, txTransferData).encodeABI();
        await transactionSender.sendTransaction(this.multiSigContract.options.address, txData, 0, this.config.privateKey);
        this.logger.info(`Transaction ${log.transactionHash} submitted to multisig`);
    }

    _saveProgress (path, value) {
        if (value) {
            fs.writeFileSync(path, value);
        }
    }
}
