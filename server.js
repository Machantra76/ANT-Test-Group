require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const line = require('@line/bot-sdk');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 🟢 POSTGRESQL DATABASE CONNECTION (Neon DB)
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// បង្កើត Table សម្រាប់រក្សាទុកប្រវត្តិការផ្ញើសារ (Logs)
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notification_logs (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50),
                recipient TEXT,
                message TEXT,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ បានតភ្ជាប់ និងបង្កើត Table ក្នុង Neon DB ជោគជ័យ!');
    } catch (err) {
        console.error('❌ កំហុសក្នុងការតភ្ជាប់ Database:', err.message);
    }
}
initDatabase();

// Function ជួយບັນទឹករាល់ Log នៃការផ្ញើសារចូល Database
async function saveLog(channel, recipient, message, status) {
    try {
        await pool.query(
            'INSERT INTO notification_logs (channel, recipient, message, status) VALUES ($1, $2, $3, $4)',
            [channel, recipient, message, status]
        );
    } catch (err) {
        console.error('❌ Error saving log to DB:', err.message);
    }
}

// ==========================================
// ១. TELEGRAM BOT INITIALIZATION
// ==========================================
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;

if (telegramToken && telegramToken !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    telegramBot = new TelegramBot(telegramToken, { polling: true });
    console.log('✅ បានភ្ជាប់ទៅកាន់ Telegram Bot ដោយជោគជ័យ!');

    telegramBot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const chatTitle = msg.chat.title || 'Private Chat';
        console.log(`Telegram Notification - Chat ID: ${chatId} | Title/Name: "${chatTitle}"`);
    });
} else {
    console.log('⚠️ សូមកំណត់ TELEGRAM_BOT_TOKEN នៅក្នុង .env');
}

// ==========================================
// ⏰ កំណត់ម៉ោងស្វ័យប្រវត្តិផ្ញើសារ (ថ្ងៃទី 20-10-2026 ម៉ោង 22:58)
// ==========================================
cron.schedule('58 22 20 10 *', async () => {
    console.log('⏰ កំពុងដំណើរការផ្ញើសារស្វ័យប្រវត្តិទៅ Telegram Group...');
    const targetChatId = process.env.TELEGRAM_GROUP_CHAT_ID;

    if (telegramBot && targetChatId && targetChatId !== '-100XXXXXXXXXX') {
        try {
            await telegramBot.sendMessage(targetChatId, 'Hi', { parse_mode: 'HTML' });
            await saveLog('Telegram', targetChatId, 'Hi', 'Success (Scheduled)');
            console.log('📩 បានផ្ញើសារស្វ័យប្រវត្តិ "Hi" ចូល Group ដោយជោគជ័យ!');
        } catch (err) {
            await saveLog('Telegram', targetChatId, 'Hi', `Failed: ${err.message}`);
            console.error('❌ កំហុសក្នុងការផ្ញើសារស្វ័យប្រវត្តិ:', err.message);
        }
    } else {
        console.log('⚠️ Telegram Bot ឬ Group Chat ID មិនទាន់ត្រឹមត្រូវ!');
    }
}, {
    scheduled: true,
    timezone: "Asia/Phnom_Penh"
});

// ==========================================
// ២. WHATSAPP WEB CLIENT INITIALIZATION
// ==========================================
const whatsappClient = new Client({
    authStrategy: new LocalAuth()
});

whatsappClient.on('qr', (qr) => {
    console.log('📲 សូមស្កេន QR Code ខាងក្រោមនៅលើ WhatsApp ទូរស័ព្ទរបស់អ្នក៖');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.log('✅ បានភ្ជាប់ទៅកាន់ WhatsApp Web Client រួចរាល់!');
});

whatsappClient.initialize();

// ==========================================
// 3. LINE BOT INITIALIZATION
// ==========================================
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = new line.Client(lineConfig);

// ==========================================
// API ROUTES
// ==========================================

// ១. Telegram API
app.post('/api/notify/telegram', async (req, res) => {
    const { chatId, message } = req.body;
    const targetChatId = chatId || process.env.TELEGRAM_GROUP_CHAT_ID;

    if (!telegramBot) {
        return res.status(400).json({ success: false, error: 'Telegram Bot មិនទាន់ត្រូវបានរៀបចំក្នុង .env ទេ!' });
    }

    try {
        await telegramBot.sendMessage(targetChatId, message, { parse_mode: 'HTML' });
        await saveLog('Telegram', targetChatId, message, 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ Telegram Group ដោយជោគជ័យ!' });
    } catch (err) {
        await saveLog('Telegram', targetChatId, message, `Failed: ${err.message}`);
        console.error('Error sending Telegram message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ២. WhatsApp API
app.post('/api/notify/whatsapp', async (req, res) => {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល លេខទូរស័ព្ទ និង អត្ថបទសារ!' });
    }

    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const formattedNumber = `${cleanNumber}@c.us`;
        await whatsappClient.sendMessage(formattedNumber, message);
        await saveLog('WhatsApp', phoneNumber, message, 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ WhatsApp ដោយជោគជ័យ!' });
    } catch (err) {
        await saveLog('WhatsApp', phoneNumber, message, `Failed: ${err.message}`);
        console.error('Error sending WhatsApp message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៣. LINE API
app.post('/api/notify/line', async (req, res) => {
    const { userId, message } = req.body;

    if (!userId || !message) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល LINE User ID និង អត្ថបទសារ!' });
    }

    try {
        await lineClient.pushMessage(userId, { type: 'text', text: message });
        await saveLog('LINE', userId, message, 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ LINE ដោយជោគជ័យ!' });
    } catch (err) {
        await saveLog('LINE', userId, message, `Failed: ${err.message}`);
        console.error('Error sending LINE message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៤. Broadcast API
app.post('/api/notify/broadcast', async (req, res) => {
    const { message, telegramChatId, whatsappPhone, lineUserId } = req.body;
    const status = {};

    if (telegramBot) {
        const tChatId = telegramChatId || process.env.TELEGRAM_GROUP_CHAT_ID;
        try {
            await telegramBot.sendMessage(tChatId, message, { parse_mode: 'HTML' });
            await saveLog('Telegram (Broadcast)', tChatId, message, 'Success');
            status.telegram = 'ជោគជ័យ (Success)';
        } catch (e) {
            await saveLog('Telegram (Broadcast)', tChatId, message, `Failed: ${e.message}`);
            status.telegram = `បរាជ័យ: ${e.message}`;
        }
    }

    if (whatsappPhone) {
        try {
            const cleanNumber = whatsappPhone.replace(/[^0-9]/g, '');
            await whatsappClient.sendMessage(`${cleanNumber}@c.us`, message);
            await saveLog('WhatsApp (Broadcast)', whatsappPhone, message, 'Success');
            status.whatsapp = 'ជោគជ័យ (Success)';
        } catch (e) {
            await saveLog('WhatsApp (Broadcast)', whatsappPhone, message, `Failed: ${e.message}`);
            status.whatsapp = `បរាជ័យ: ${e.message}`;
        }
    }

    if (lineUserId && lineConfig.channelAccessToken) {
        try {
            await lineClient.pushMessage(lineUserId, { type: 'text', text: message });
            await saveLog('LINE (Broadcast)', lineUserId, message, 'Success');
            status.line = 'ជោគជ័យ (Success)';
        } catch (e) {
            await saveLog('LINE (Broadcast)', lineUserId, message, `Failed: ${e.message}`);
            status.line = `បរាជ័យ: ${e.message}`;
        }
    }

    res.json({ success: true, status });
});

// 🟢 ៥. API ទាញយកប្រវត្តិការផ្ញើសារ (Get Logs from DB)
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Route បើកទំព័រ UI ដើម
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Notification Hub Server កំពុងដំណើរការលើ http://localhost:${PORT}`);
});
