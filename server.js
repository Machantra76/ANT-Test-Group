require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const line = require('@line/bot-sdk');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
} else {
    console.log('⚠️ សូមកំណត់ TELEGRAM_BOT_TOKEN នៅក្នុង .env');
}

// ⏰ កំណត់ម៉ោងស្វ័យប្រវត្តិផ្ញើសារ
cron.schedule('58 22 20 10 *', async () => {
    console.log('⏰ កំពុងដំណើរការផ្ញើសារស្វ័យប្រវត្តិទៅ Telegram Group...');
    const targetChatId = process.env.TELEGRAM_GROUP_CHAT_ID;

    if (telegramBot && targetChatId) {
        try {
            await telegramBot.sendMessage(targetChatId, 'Hi', { parse_mode: 'HTML' });
            await saveLog('Telegram', targetChatId, 'Hi', 'Success (Scheduled)');
            console.log('📩 បានផ្ញើសារស្វ័យប្រវត្តិ "Hi" ចូល Group ដោយជោគជ័យ!');
        } catch (err) {
            await saveLog('Telegram', targetChatId, 'Hi', `Failed: ${err.message}`);
            console.error('❌ កំហុសក្នុងការផ្ញើសារស្វ័យប្រវត្តិ:', err.message);
        }
    }
}, {
    scheduled: true,
    timezone: "Asia/Phnom_Penh"
});

// ==========================================
// ២. WHATSAPP WEB CLIENT INITIALIZATION (Render Optimized)
// ==========================================
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

whatsappClient.on('qr', (qr) => {
    console.log('📲 សូមស្កេន QR Code ខាងក្រោមនៅលើ WhatsApp ទូរស័ព្ទរបស់អ្នក៖');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.log('✅ បានភ្ជាប់ទៅកាន់ WhatsApp Web Client រួចរាល់!');
});

whatsappClient.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp Authentication Failed:', msg);
});

whatsappClient.initialize().catch(err => {
    console.error('⚠️ WhatsApp Client initialization warning/error:', err.message);
});

// ==========================================
// ៣. LINE BOT INITIALIZATION
// ==========================================
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = new line.Client(lineConfig);

// ==========================================
// API ROUTES
// ==========================================

// ១. Telegram API (គាំទ្រទាំងអត្ថបទសារ និងរូបភាព)
app.post('/api/notify/telegram', async (req, res) => {
    const { chatId, message, imageUrl } = req.body;
    const targetChatId = chatId || process.env.TELEGRAM_GROUP_CHAT_ID;

    if (!telegramBot) {
        return res.status(400).json({ success: false, error: 'Telegram Bot មិនទាន់ត្រូវបានរៀបចំទេ!' });
    }

    try {
        if (imageUrl) {
            await telegramBot.sendPhoto(targetChatId, imageUrl, { caption: message, parse_mode: 'HTML' });
        } else {
            await telegramBot.sendMessage(targetChatId, message, { parse_mode: 'HTML' });
        }
        await saveLog('Telegram', targetChatId, message || '[Photo]', 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ Telegram Group ដោយជោគជ័យ!' });
    } catch (err) {
        await saveLog('Telegram', targetChatId, message || '[Photo]', `Failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ២. WhatsApp API (គាំទ្រទាំងអត្ថបទសារ និងរូបភាព)
app.post('/api/notify/whatsapp', async (req, res) => {
    const { phoneNumber, message, imageUrl } = req.body;

    if (!phoneNumber || (!message && !imageUrl)) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល លេខទូរស័ព្ទ និង អត្ថបទសារ ឬ Link រូបភាព!' });
    }

    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const formattedNumber = `${cleanNumber}@c.us`;

        if (imageUrl) {
            const media = await MessageMedia.fromUrl(imageUrl);
            await whatsappClient.sendMessage(formattedNumber, media, { caption: message });
        } else {
            await whatsappClient.sendMessage(formattedNumber, message);
        }

        await saveLog('WhatsApp', phoneNumber, message || '[Photo]', 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ WhatsApp ដោយជោគជ័យ!' });
    } catch (err) {
        await saveLog('WhatsApp', phoneNumber, message || '[Photo]', `Failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៣. LINE API (គាំទ្រទាំងអត្ថបទសារ និងរូបភាព)
app.post('/api/notify/line', async (req, res) => {
    const { userId, message, imageUrl } = req.body;

    if (!userId || (!message && !imageUrl)) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល LINE User ID និង អត្ថបទសារ ឬ Link រូបភាព!' });
    }

    try {
        const messages = [];
        if (imageUrl) {
            messages.push({
                type: 'image',
                originalContentUrl: imageUrl,
                previewImageUrl: imageUrl
            });
        }
        if (message) {
            messages.push({ type: 'text', text: message });
        }

        await lineClient.pushMessage(userId, messages);
        await saveLog('LINE', userId, message || '[Photo]', 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ LINE ដោយជោគជ័យ!' });
    } catch (err) {
        await saveLog('LINE', userId, message || '[Photo]', `Failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៤. Broadcast API (គាំទ្រគ្រប់ Channel ទាំងអស់)
app.post('/api/notify/broadcast', async (req, res) => {
    const { message, imageUrl, telegramChatId, whatsappPhone, lineUserId } = req.body;
    const status = {};

    if (telegramBot) {
        const tChatId = telegramChatId || process.env.TELEGRAM_GROUP_CHAT_ID;
        try {
            if (imageUrl) {
                await telegramBot.sendPhoto(tChatId, imageUrl, { caption: message, parse_mode: 'HTML' });
            } else {
                await telegramBot.sendMessage(tChatId, message, { parse_mode: 'HTML' });
            }
            await saveLog('Telegram (Broadcast)', tChatId, message || '[Photo]', 'Success');
            status.telegram = 'ជោគជ័យ (Success)';
        } catch (e) {
            await saveLog('Telegram (Broadcast)', tChatId, message || '[Photo]', `Failed: ${e.message}`);
            status.telegram = `បរាជ័យ: ${e.message}`;
        }
    }

    if (whatsappPhone) {
        try {
            const cleanNumber = whatsappPhone.replace(/[^0-9]/g, '');
            const formattedNumber = `${cleanNumber}@c.us`;
            if (imageUrl) {
                const media = await MessageMedia.fromUrl(imageUrl);
                await whatsappClient.sendMessage(formattedNumber, media, { caption: message });
            } else {
                await whatsappClient.sendMessage(formattedNumber, message);
            }
            await saveLog('WhatsApp (Broadcast)', whatsappPhone, message || '[Photo]', 'Success');
            status.whatsapp = 'ជោគជ័យ (Success)';
        } catch (e) {
            await saveLog('WhatsApp (Broadcast)', whatsappPhone, message || '[Photo]', `Failed: ${e.message}`);
            status.whatsapp = `បរាជ័យ: ${e.message}`;
        }
    }

    if (lineUserId && lineConfig.channelAccessToken) {
        try {
            const messages = [];
            if (imageUrl) {
                messages.push({
                    type: 'image',
                    originalContentUrl: imageUrl,
                    previewImageUrl: imageUrl
                });
            }
            if (message) {
                messages.push({ type: 'text', text: message });
            }
            await lineClient.pushMessage(lineUserId, messages);
            await saveLog('LINE (Broadcast)', lineUserId, message || '[Photo]', 'Success');
            status.line = 'ជោគជ័យ (Success)';
        } catch (e) {
            await saveLog('LINE (Broadcast)', lineUserId, message || '[Photo]', `Failed: ${e.message}`);
            status.line = `បរាជ័យ: ${e.message}`;
        }
    }

    res.json({ success: true, status });
});

// ៥. API រក្សាទុកកាលវិភាគផ្ញើសារ (Schedule Notification API)
app.post('/api/notify/schedule', async (req, res) => {
    const { channel, message, imageUrl, recipient, scheduleTime } = req.body;

    if ((!message && !imageUrl) || !scheduleTime) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ជាក់អត្ថបទសារ/រូបភាព និងពេលវេលា!' });
    }

    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS scheduled_messages (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50),
                recipient TEXT,
                message TEXT,
                image_url TEXT,
                schedule_time TIMESTAMP,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        );

        await pool.query(
            'INSERT INTO scheduled_messages (channel, recipient, message, image_url, schedule_time) VALUES ($1, $2, $3, $4, $5)',
            [channel, recipient, message, imageUrl, scheduleTime]
        );

        res.json({ success: true, message: `បានកំណត់ពេលផ្ញើសារសម្រាប់ថ្ងៃទី ${scheduleTime} ជោគជ័យ!` });
    } catch (err) {
        console.error('Error scheduling message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៦. API ទាញយកប្រវត្តិការផ្ញើសារ (Get Logs from DB)
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
