require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
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

const upload = multer({ storage: multer.memoryStorage() });

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
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50),
                recipient TEXT,
                message TEXT,
                image_data BYTEA,
                image_mimetype VARCHAR(100),
                schedule_time TIMESTAMP,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ បានតភ្ជាប់ និងបង្កើត Tables ក្នុង Neon DB ជោគជ័យ!');
    } catch (err) {
        console.error('❌ កំហុស Database:', err.message);
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
        console.error('❌ Error saving log:', err.message);
    }
}

// Telegram Setup
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;
if (telegramToken && telegramToken !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    telegramBot = new TelegramBot(telegramToken, { polling: true });
    console.log('✅ Telegram Bot បានតភ្ជាប់!');
}

// WhatsApp Setup
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});
whatsappClient.on('qr', (qr) => qrcode.generate(qr, { small: true }));
whatsappClient.on('ready', () => console.log('✅ WhatsApp Client រួចរាល់!'));
whatsappClient.initialize().catch(err => console.error('WhatsApp Error:', err.message));

// LINE Setup
const lineClient = new line.Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
});

// ฟังก์ชันสำหรับส่งข้อความจริงไปยังแต่ละช่องทาง
async function executeNotification(channel, recipient, message, file) {
    let tempFilePath = null;
    if (file && file.buffer) {
        const fs = require('fs');
        const ext = file.mimetype ? file.mimetype.split('/')[1] : 'jpg';
        tempFilePath = path.join(__dirname, `temp_${Date.now()}.${ext}`);
        fs.writeFileSync(tempFilePath, file.buffer);
    }

    if (channel === 'telegram' || channel === 'broadcast') {
        const targetChatId = recipient || process.env.TELEGRAM_GROUP_CHAT_ID;
        if (targetChatId && telegramBot) {
            if (tempFilePath) {
                await telegramBot.sendPhoto(targetChatId, tempFilePath, { caption: message || '', parse_mode: 'HTML' });
            } else {
                await telegramBot.sendMessage(targetChatId, message || '', { parse_mode: 'HTML' });
            }
            await saveLog('Telegram', targetChatId, message || '[Photo]', 'Success');
        }
    }

    if (channel === 'whatsapp' || (channel === 'broadcast' && recipient)) {
        const cleanNumber = (recipient || '').replace(/[^0-9]/g, '');
        if (cleanNumber) {
            const formattedNumber = `${cleanNumber}@c.us`;
            if (tempFilePath) {
                const media = new MessageMedia(file.mimetype, file.buffer.toString('base64'), file.originalname);
                await whatsappClient.sendMessage(formattedNumber, media, { caption: message || '' });
            } else {
                await whatsappClient.sendMessage(formattedNumber, message);
            }
            await saveLog('WhatsApp', recipient, message || '[Photo]', 'Success');
        }
    }

    if (channel === 'line' || channel === 'broadcast') {
        if (recipient && lineClient) {
            const messages = [];
            if (message) messages.push({ type: 'text', text: message });
            if (messages.length > 0) {
                await lineClient.pushMessage(recipient, messages);
                await saveLog('LINE', recipient, message || '[Photo]', 'Success');
            }
        }
    }

    if (tempFilePath && require('fs').existsSync(tempFilePath)) {
        require('fs').unlinkSync(tempFilePath);
    }
}

// ⏰ CRON WORKER រៀងរាល់ ១ នាទីម្តង (ផ្ញើសារតាមកាលវិភាគ)
cron.schedule('* * * * *', async () => {
    try {
        const result = await pool.query(
            `SELECT * FROM scheduled_messages WHERE schedule_time <= CURRENT_TIMESTAMP AND status = 'Pending'`
        );

        if (result.rows.length === 0) return;
        console.log(`⏰ រកឃើញសារស្វ័យប្រវត្តិចំនួន ${result.rows.length} ត្រូវផ្ញើ!`);

        for (const item of result.rows) {
            try {
                let fileObj = null;
                if (item.image_data) {
                    fileObj = { buffer: item.image_data, mimetype: item.image_mimetype, originalname: 'image.jpg' };
                }
                await executeNotification(item.channel, item.recipient, item.message, fileObj);
                await pool.query("UPDATE scheduled_messages SET status = 'Sent' WHERE id = $1", [item.id]);
                console.log(`✅ បានផ្ញើសារ Schedule ID: ${item.id} ជោគជ័យ!`);
            } catch (err) {
                console.error(`❌ បរាជ័យ Schedule ID ${item.id}:`, err.message);
                await pool.query("UPDATE scheduled_messages SET status = $1 WHERE id = $2", [`Failed: ${err.message}`, item.id]);
            }
        }
    } catch (err) {
        console.error('❌ Cron Error:', err.message);
    }
}, { scheduled: true, timezone: "UTC" });

// API ផ្ញើសារភ្លាមៗ
app.post('/api/notify/send', upload.single('image'), async (req, res) => {
    const { channel, message, phoneNumber, userId } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    try {
        await executeNotification(channel, recipient, message, req.file);
        res.json({ success: true, message: 'បានបញ្ជូនសារដោយជោគជ័យ!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API រក្សាទុកកាលវិភាគ (Schedule)
// API រក្សាទុកកាលវិភាគ (Schedule) - បានកែសម្រួលការគណនាម៉ោង UTC
// API រក្សាទុកកាលវិភាគ (Schedule) - បម្លែងម៉ោងឱ្យត្រូវជា UTC មុនរក្សាទុក
app.post('/api/notify/schedule', upload.single('image'), async (req, res) => {
    const { channel, message, scheduleTime, phoneNumber, userId } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    if (!scheduleTime) {
        return res.status(400).json({ success: false, error: 'សូមកំណត់ពេលវេលាឱ្យបានត្រឹមត្រូវ!' });
    }

    try {
        const localDate = new Date(scheduleTime);
        
        // ដកម៉ោង Local ចេញដើម្បីទូទាត់ជាមួយ UTC (ដក ៧ ម៉ោង សម្រាប់ម៉ោងនៅកម្ពុជា GMT+7)
        // ឬប្រើ getTimezoneOffset() ដើម្បីឱ្យវាស្វ័យប្រវត្តិគ្រប់ទីកន្លែង
        const utcDate = new Date(localDate.getTime() - (localDate.getTimezoneOffset() * 60000));

        await pool.query(
            'INSERT INTO scheduled_messages (channel, recipient, message, image_data, image_mimetype, schedule_time) VALUES ($1, $2, $3, $4, $5, $6)',
            [channel, recipient, message || '', req.file ? req.file.buffer : null, req.file ? req.file.mimetype : null, utcDate]
        );
        res.json({ success: true, message: `បានកំណត់ពេលផ្ញើសារសម្រាប់ថ្ងៃទី ${scheduleTime} រួចរាល់!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Server រត់លើ http://localhost:${PORT}`));
