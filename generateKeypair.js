const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

function generateKeypair() {
    const keypair = Keypair.generate();

    const publicKey = keypair.publicKey.toBase58();
    const secretKeyArray = Array.from(keypair.secretKey);

    // Приватный ключ в base58 строке

    const secretKeyBase58 = bs58.encode ? bs58.encode(keypair.secretKey) : bs58.default.encode(keypair.secretKey);

    console.log('Public Key:', publicKey);
    console.log('Secret Key (JSON array):', JSON.stringify(secretKeyArray));
    console.log('Secret Key (base58 string):', secretKeyBase58);
}

generateKeypair();
