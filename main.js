// main.js
const SolanaSnipeBot = require('./SolanaSnipeBot');

async function main() {
    const bot = new SolanaSnipeBot();

    try {
        await bot.initialize();
        // Просто не даём процессу завершиться
        setInterval(() => {}, 1 << 30);

        // Обработка сигналов для корректного завершения
        process.on('SIGINT', () => {
            console.log('\n🛑 Получен сигнал остановки...');
            bot.stop();
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Критическая ошибка:', error);
        process.exit(1);
    }
}

main();
