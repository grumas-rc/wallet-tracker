const {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    ComputeBudgetProgram,
    LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const {getMint} = require('@solana/spl-token');
const WebSocket = require('ws');
const axios = require('axios');
const {API_URLS} = require('@raydium-io/raydium-sdk-v2');
require('dotenv').config();

class SolanaSnipeBot {
    constructor() {
        // ✅ МИНИМАЛЬНЫЙ НАБОР ПЕРЕМЕННЫХ
        this.connection = new Connection(process.env.RPC_URL, 'confirmed');
        this.wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY)));
        this.targetWallet = new PublicKey(process.env.TARGET_WALLET);
        this.wsConnection = null;

        // Настройки
        this.minTransferLamports = 400 * 1e9; // 400 SOL
        this.config = {
            quoteAmount: parseFloat(process.env.QUOTE_AMOUNT),
            slippage: parseInt(process.env.BUY_SLIPPAGE),
        };

        // Простое состояние
        this.lastBalance = null;
        this.pendingTokens = new Map(); // mint -> info
        this.processedSignatures = new Set();
        this.mintCache = new Map();

        // RPC контроль
        this.rpcDelay = 5000; // 5 секунд между RPC
        this.lastRpcTime = 0;

        // ✅ PING/PONG HEARTBEAT
        this.pingInterval = null;
        this.pongTimeout = null;
        this.isAlive = false;
        this.pingIntervalMs = 30000; // 30 секунд
        this.pongTimeoutMs = 10000;  // 10 секунд ожидание pong
        // ✅ АДАПТИВНЫЙ HEARTBEAT
        this.lastActivity = Date.now();
        this.activityBasedPing = true; // Включить адаптивный режим
    }

    async initialize() {
        console.log('🚀 Запуск Solana Snipe Bot');
        console.log(`🎯 Target: ${this.targetWallet.toString()}`);
        console.log(`💰 Минимальный перевод: ${this.minTransferLamports / 1e9} SOL`);
        await this.fetchInitialBalance();
        await this.startWebSocket();
    }
    async fetchInitialBalance() {
        const lamports = await this.connection.getBalance(this.targetWallet, 'confirmed');
        this.lastBalance = lamports;
        console.log(`🔎 Стартовый баланс: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${lamports} lamports)`);
    }
    // ✅ WebSocket
    async startWebSocket() {
        this.wsConnection = new WebSocket(process.env.WS_URL);

        this.wsConnection.on('open', () => {
            console.log('✅ WebSocket подключен');
            this.isAlive = true;
            this.subscribe();
            this.startHeartbeat(); // ✅ Запускаем heartbeat
        });

        this.wsConnection.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.handleMessage(message);
            } catch (error) {
                console.error('❌ WebSocket ошибка:', error);
            }
        });

        // ✅ ОБРАБОТКА PONG ОТВЕТА
        this.wsConnection.on('pong', () => {
            console.log('🏓 Получен pong - соединение живое');
            this.isAlive = true;

            // Очищаем timeout ожидания pong
            if (this.pongTimeout) {
                clearTimeout(this.pongTimeout);
                this.pongTimeout = null;
            }
        });

        // ✅ ОБРАБОТКА PING ОТ СЕРВЕРА (автоматический pong)
        this.wsConnection.on('ping', (data) => {
            console.log('🏓 Получен ping от сервера, отправляем pong');
            this.wsConnection.pong(data);
        });

        this.wsConnection.on('close', (code, reason) => {
            console.log(`🔴 WebSocket отключен (${code}): ${reason}`);
            this.stopHeartbeat(); // ✅ Останавливаем heartbeat

            // Переподключение через 2 секунды
            setTimeout(() => this.startWebSocket(), 2000);
        });

        this.wsConnection.on('error', (error) => {
            console.error('❌ WebSocket ошибка:', error);
        });
    }

    // ✅ ПРОСТАЯ ПОДПИСКА
    subscribe() {
        // Баланс кошелька
        this.wsConnection.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'accountSubscribe',
            params: [this.targetWallet.toString(), {commitment: 'confirmed'}]
        }));

        // События логов
        this.wsConnection.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'logsSubscribe',
            params: [{mentions: [this.targetWallet.toString()]}, {commitment: 'confirmed'}]
        }));
    }

    // ✅ ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
    async handleMessage(message) {
        // ✅ ОБНОВЛЕНИЕ АКТИВНОСТИ ПРИ ЛЮБОМ СООБЩЕНИИ
        // ✅ ОТМЕЧАЕМ АКТИВНОСТЬ
        this.lastActivity = Date.now();

        // Изменение баланса
        if (message.method === 'accountNotification') {
            await this.handleBalanceChange(message);
            return;
        }

        // События в логах
        if (message.method === 'logsNotification') {
            await this.handleLogEvent(message);
            return;
        }
    }

    // ✅ ОБРАБОТКА ИЗМЕНЕНИЯ БАЛАНСА
    async handleBalanceChange(message) {
        const newBalance = message.params.result.value.lamports;
        const oldBalance = this.lastBalance || newBalance;
        const delta = newBalance - oldBalance;

        // console.log(`💳 Баланс: ${(newBalance / 1e9).toFixed(6)} SOL (${delta > 0 ? '+' : ''}${(delta / 1e9).toFixed(6)})`);

        // ✅ КРУПНЫЙ ИСХОДЯЩИЙ ПЕРЕВОД
        if (delta < -this.minTransferLamports) {
            const amount = Math.abs(delta / 1e9);
            console.log(`🚨 КРУПНЫЙ ПЕРЕВОД: ${amount.toFixed(2)} SOL`);

            const recipient = await this.findRecipient(amount);
            if (recipient) {
                await this.switchTarget(recipient, amount);
            }
        }

        this.lastBalance = newBalance;
    }

    // ✅ ОБРАБОТКА СОБЫТИЙ ЛОГОВ
    async handleLogEvent(message) {
        const {signature, logs} = message.params.result.value;

        if (this.processedSignatures.has(signature)) return;
        this.processedSignatures.add(signature);

        // ✅ MINT СОБЫТИЕ
        if (this.isMintEvent(logs)) {
            console.log(`🎯 Mint: ${signature}`);
            const mintAddress = await this.extractMint(signature);
            if (mintAddress) {
                console.log(`🪙 Token: ${mintAddress}`);
                this.pendingTokens.set(mintAddress, {time: Date.now()});
            }
        }

        // ✅ POOL СОБЫТИЕ
        if (this.isPoolEvent(logs)) {
            console.log(`🏊 Pool: ${signature}`);
            const poolMint = await this.extractMint(signature);
            if (poolMint && this.pendingTokens.has(poolMint)) {
                console.log(`✅ Пул создан для токена: ${poolMint}`);
                await this.executePurchase(poolMint);
                this.pendingTokens.delete(poolMint);
            }
        }
    }

    // ✅ ПРОВЕРКА ТИПА СОБЫТИЯ
    isMintEvent(logs) {
        return logs.some(log => /Instruction: MintTo|InitializeMint/.test(log));
    }

    isPoolEvent(logs) {
        return logs.some(log => /InitializePool|CreatePool/.test(log));
    }

    // ✅ ИЗВЛЕЧЕНИЕ MINT АДРЕСА
    async extractMint(signature) {
        try {
            const tx = await this.getRpcData(() => this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            }));

            if (!tx?.meta?.postTokenBalances) return null;

            // Ищем новый токен в balances
            for (const balance of tx.meta.postTokenBalances) {
                const mint = balance.mint;
                if (mint && mint !== 'So11111111111111111111111111111111111111112') {
                    if (await this.isValidMint(mint)) {
                        return mint;
                    }
                }
            }
            return null;
        } catch (error) {
            console.error(`❌ Ошибка извлечения mint: ${error.message}`);
            return null;
        }
    }

    // ✅ ПОИСК ПОЛУЧАТЕЛЯ КРУПНОГО ПЕРЕВОДА
    async findRecipient(transferAmount) {
        try {
            console.log(`🔍 Ищем получателя ${transferAmount} SOL...`);

            const signatures = await this.getRpcData(() =>
                this.connection.getSignaturesForAddress(this.targetWallet, {limit: 2})
            );

            if (!signatures?.length) return null;

            // Анализируем последнюю транзакцию
            const lastSig = signatures[0];
            if (lastSig.err) return null;

            const tx = await this.getRpcData(() => this.connection.getTransaction(lastSig.signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            }));

            if (!tx?.meta) return null;

            const {accountKeys} = tx.transaction.message;
            const {preBalances, postBalances} = tx.meta;

            // Находим кто получил деньги
            for (let i = 0; i < accountKeys.length; i++) {
                const delta = postBalances[i] - preBalances[i];
                const gain = delta / 1e9;

                if (gain >= transferAmount * 0.9) { // 90% от суммы
                    const recipient = accountKeys[i].toString();
                    console.log(`✅ Получатель найден: ${recipient}`);
                    return recipient;
                }
            }

            return null;
        } catch (error) {
            console.error(`❌ Ошибка поиска получателя: ${error.message}`);
            return null;
        }
    }

    // ✅ ПЕРЕКЛЮЧЕНИЕ НА НОВЫЙ КОШЕЛЕК
    async switchTarget(newAddress, amount) {
        const oldAddress = this.targetWallet.toString();

        console.log(`🔄 ПЕРЕКЛЮЧЕНИЕ:`);
        console.log(`   Старый: ${oldAddress}`);
        console.log(`   Новый: ${newAddress}`);
        console.log(`   Сумма: ${amount.toFixed(2)} SOL`);

        // Обновляем target
        this.targetWallet = new PublicKey(newAddress);
        this.lastBalance = null;
        this.pendingTokens.clear();
        this.processedSignatures.clear();

        // ✅ ОСТАНАВЛИВАЕМ HEARTBEAT ПЕРЕД ПЕРЕПОДКЛЮЧЕНИЕМ
        this.stopHeartbeat();

        // Переподключаемся
        await this.delay(1000);
        this.wsConnection.close(); // Heartbeat перезапустится автоматически при открытии
    }

    // ✅ ВАЛИДАЦИЯ MINT
    async isValidMint(mintAddress) {
        try {
            if (this.mintCache.has(mintAddress)) {
                return this.mintCache.get(mintAddress);
            }

            const mint = await this.getRpcData(() => getMint(this.connection, new PublicKey(mintAddress)));
            const isValid = mint !== null;

            this.mintCache.set(mintAddress, isValid);
            return isValid;
        } catch {
            return false;
        }
    }

    // ✅ RPC С THROTTLING
    async getRpcData(rpcCall) {
        const elapsed = Date.now() - this.lastRpcTime;
        if (elapsed < this.rpcDelay) {
            await this.delay(this.rpcDelay - elapsed);
        }

        this.lastRpcTime = Date.now();
        return await rpcCall();
    }

    // ✅ ПОКУПКА ТОКЕНА
    async executePurchase(mintAddress) {
        console.log(`💰 Покупка токена: ${mintAddress}`);
        // Заглушка - здесь будет логика покупки
        return;
    }

    // ✅ УТИЛИТЫ
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        console.log('🛑 Остановка бота');

        this.stopHeartbeat(); // ✅ Останавливаем heartbeat

        if (this.wsConnection) {
            this.wsConnection.close();
        }
    }

    // ✅ ЗАПУСК HEARTBEAT МЕХАНИЗМА
    startHeartbeat() {
        this.stopHeartbeat();

        console.log(`💗 Запуск адаптивного heartbeat`);

        this.pingInterval = setInterval(() => {
            if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
                return;
            }

            // ✅ PING ТОЛЬКО ЕСЛИ ДАВНО НЕ БЫЛО АКТИВНОСТИ
            const timeSinceActivity = Date.now() - this.lastActivity;
            const needsPing = timeSinceActivity > (this.pingIntervalMs - 5000); // За 5 сек до timeout

            if (this.activityBasedPing && !needsPing) {
                this.isAlive = true; // Считаем живым если есть активность
                return;
            }

            if (!this.isAlive) {
                console.log('💀 Соединение мертво, закрываем...');
                this.wsConnection.terminate();
                return;
            }

            this.isAlive = false;
            console.log(`🏓 Отправляем ping (бездействие ${Math.round(timeSinceActivity/1000)}с)`);
            this.wsConnection.ping();

            this.pongTimeout = setTimeout(() => {
                console.log('💀 Pong не получен, соединение мертво');
                this.isAlive = false;
                this.wsConnection.terminate();
            }, this.pongTimeoutMs);

        }, this.pingIntervalMs);
    }

    // ✅ ОСТАНОВКА HEARTBEAT
    stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }
}

module.exports = SolanaSnipeBot;
