require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // 🟢 បន្ថែម multer សម្រាប់ Upload File
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // បើកថត uploads ឱ្យສາມາດចូលមើលរូបភាពបាន

// រៀបចំកន្លែងរក្សាទុករូបភាពដែល Upload ចូលមក
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

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

// ==========================================
// ២. WHATSAPP WEB CLIENT INITIALIZATION
// ==========================================
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

whatsappClient.on('qr', (qr) => {
    console.log('📲 សូមស្កេន QR Code នៅលើ WhatsApp៖');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.log('✅ បានភ្ជាប់ទៅកាន់ WhatsApp Web Client រួចរាល់!');
});

whatsappClient.initialize().catch(err => {
    console.error('⚠️ WhatsApp Client initialization warning:', err.message);
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
// ⏰ CRON WORKER រៀងរាល់ ១ នាទីម្តង (សម្រាប់ផ្ញើសារតាមកាលវិភាគ)
// ==========================================
// ==========================================
// ⏰ CRON WORKER រៀងរាល់ ១ នាទីម្តង (ផ្ញើសារតាមកាលវិភាគ - កែសម្រួល Timezone ស្របតាមកម្ពុជា)
// ==========================================
cron.schedule('* * * * *', async () => {
    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS scheduled_messages (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50),
                recipient TEXT,
                message TEXT,
                image_path TEXT,
                schedule_time TIMESTAMP,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        );

        // បម្លែងម៉ោងបច្ចុប្បន្នឱ្យត្រូវនឹងម៉ោងក្នុងតំបន់ ភ្នំពេញ (Asia/Phnom_Penh)
        const result = await pool.query(
            `SELECT * FROM scheduled_messages 
             WHERE schedule_time <= (NOW() AT TIME ZONE 'Asia/Phnom_Penh') AND status = 'Pending'`
        );

        const pendingMessages = result.rows;
        if (pendingMessages.length === 0) return;

        console.log(`⏰ រកឃើញសារដែលត្រូវផ្ញើស្វ័យប្រវត្តិចំនួន ${pendingMessages.length} ម៉ោង!`);

        for (const item of pendingMessages) {
            try {
                if (item.channel === 'telegram') {
                    const targetChatId = item.recipient || process.env.TELEGRAM_GROUP_CHAT_ID;
                    if (item.image_path) {
                        await telegramBot.sendPhoto(targetChatId, item.image_path, { caption: item.message || '', parse_mode: 'HTML' });
                    } else {
                        await telegramBot.sendMessage(targetChatId, item.message || '', { parse_mode: 'HTML' });
                    }
                } else if (item.channel === 'whatsapp') {
                    const cleanNumber = item.recipient.replace(/[^0-9]/g, '');
                    const formattedNumber = `${cleanNumber}@c.us`;
                    if (item.image_path) {
                        const media = MessageMedia.fromFilePath(item.image_path);
                        await whatsappClient.sendMessage(formattedNumber, media, { caption: item.message || '' });
                    } else {
                        await whatsappClient.sendMessage(formattedNumber, item.message);
                    }
                } else if (item.channel === 'line') {
                    const messages = [];
                    if (item.image_path) {
                        const baseUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000';
                        const publicImageUrl = `${baseUrl}/${item.image_path.replace(/\\/g, '/')}`;
                        messages.push({ type: 'image', originalContentUrl: publicImageUrl, previewImageUrl: publicImageUrl });
                    }
                    if (item.message) messages.push({ type: 'text', text: item.message });
                    await lineClient.pushMessage(item.recipient, messages);
                }

                await pool.query("UPDATE scheduled_messages SET status = 'Sent' WHERE id = $1", [item.id]);
                await saveLog(item.channel, item.recipient, item.message || '[Photo]', 'Success (Scheduled)');
                console.log(`✅ បានផ្ញើសារស្វ័យប្រវត្តិ ID: ${item.id} ជោគជ័យ!`);

            } catch (err) {
                console.error(`❌ បរាជ័យក្នុងការផ្ញើសារ ID ${item.id}:`, err.message);
                await pool.query("UPDATE scheduled_messages SET status = $1 WHERE id = $2", [`Failed: ${err.message}`, item.id]);
            }
        }
    } catch (err) {
        console.error('❌ កំហុសក្នុង Cron Worker:', err.message);
    }
}, {
    scheduled: true,
    timezone: "Asia/Phnom_Penh"
});

// ==========================================
// API ROUTES (គាំទ្រ File Upload)
// ==========================================

// ១. Telegram API
app.post('/api/notify/telegram', upload.single('image'), async (req, res) => {
    const { chatId, message } = req.body;
    const targetChatId = chatId || process.env.TELEGRAM_GROUP_CHAT_ID;
    const file = req.file;

    try {
        if (file) {
            await telegramBot.sendPhoto(targetChatId, file.path, { caption: message || '', parse_mode: 'HTML' });
        } else {
            await telegramBot.sendMessage(targetChatId, message || '', { parse_mode: 'HTML' });
        }
        await saveLog('Telegram', targetChatId, message || '[Photo]', 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ Telegram ជោគជ័យ!' });
    } catch (err) {
        await saveLog('Telegram', targetChatId, message || '[Photo]', `Failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ២. WhatsApp API
app.post('/api/notify/whatsapp', upload.single('image'), async (req, res) => {
    const { phoneNumber, message } = req.body;
    const file = req.file;

    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូលលេខទូរស័ព្ទ WhatsApp!' });
    }

    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const formattedNumber = `${cleanNumber}@c.us`;

        if (file) {
            const media = MessageMedia.fromFilePath(file.path);
            await whatsappClient.sendMessage(formattedNumber, media, { caption: message || '' });
        } else {
            await whatsappClient.sendMessage(formattedNumber, message);
        }

        await saveLog('WhatsApp', phoneNumber, message || '[Photo]', 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ WhatsApp ជោគជ័យ!' });
    } catch (err) {
        await saveLog('WhatsApp', phoneNumber, message || '[Photo]', `Failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៣. LINE API
app.post('/api/notify/line', upload.single('image'), async (req, res) => {
    const { userId, message } = req.body;
    const file = req.file;

    if (!userId) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល LINE User ID!' });
    }

    try {
        const messages = [];
        if (file) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const publicImageUrl = `${baseUrl}/uploads/${file.filename}`;
            messages.push({
                type: 'image',
                originalContentUrl: publicImageUrl,
                previewImageUrl: publicImageUrl
            });
        }
        if (message) {
            messages.push({ type: 'text', text: message });
        }

        await lineClient.pushMessage(userId, messages);
        await saveLog('LINE', userId, message || '[Photo]', 'Success');
        res.json({ success: true, message: 'បានផ្ញើសារទៅ LINE ជោគជ័យ!' });
    } catch (err) {
        await saveLog('LINE', userId, message || '[Photo]', `Failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៤. Broadcast API
app.post('/api/notify/broadcast', upload.single('image'), async (req, res) => {
    const { message, whatsappPhone, lineUserId } = req.body;
    const file = req.file;
    const status = {};

    if (telegramBot) {
        const tChatId = process.env.TELEGRAM_GROUP_CHAT_ID;
        try {
            if (file) {
                await telegramBot.sendPhoto(tChatId, file.path, { caption: message || '', parse_mode: 'HTML' });
            } else {
                await telegramBot.sendMessage(tChatId, message || '', { parse_mode: 'HTML' });
            }
            await saveLog('Telegram (Broadcast)', tChatId, message || '[Photo]', 'Success');
            status.telegram = 'ជោគជ័យ';
        } catch (e) {
            status.telegram = `បរាជ័យ: ${e.message}`;
        }
    }

    if (whatsappPhone) {
        try {
            const cleanNumber = whatsappPhone.replace(/[^0-9]/g, '');
            if (file) {
                const media = MessageMedia.fromFilePath(file.path);
                await whatsappClient.sendMessage(`${cleanNumber}@c.us`, media, { caption: message || '' });
            } else {
                await whatsappClient.sendMessage(`${cleanNumber}@c.us`, message);
            }
            await saveLog('WhatsApp (Broadcast)', whatsappPhone, message || '[Photo]', 'Success');
            status.whatsapp = 'ជោគជ័យ';
        } catch (e) {
            status.whatsapp = `បរាជ័យ: ${e.message}`;
        }
    }

    if (lineUserId && lineConfig.channelAccessToken) {
        try {
            const messages = [];
            if (file) {
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                const publicImageUrl = `${baseUrl}/uploads/${file.filename}`;
                messages.push({ type: 'image', originalContentUrl: publicImageUrl, previewImageUrl: publicImageUrl });
            }
            if (message) messages.push({ type: 'text', text: message });

            await lineClient.pushMessage(lineUserId, messages);
            await saveLog('LINE (Broadcast)', lineUserId, message || '[Photo]', 'Success');
            status.line = 'ជោគជ័យ';
        } catch (e) {
            status.line = `បរាជ័យ: ${e.message}`;
        }
    }

    res.json({ success: true, status });
});

// ៥. API រក្សាទុកកាលវិភាគ
app.post('/api/notify/schedule', upload.single('image'), async (req, res) => {
    const { channel, message, scheduleTime, phoneNumber, userId } = req.body;
    const file = req.file;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    if ((!message && !file) || !scheduleTime) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ជាក់សារ/រូបភាព និងពេលវេលា!' });
    }

    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS scheduled_messages (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50),
                recipient TEXT,
                message TEXT,
                image_path TEXT,
                schedule_time TIMESTAMP,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        );

        await pool.query(
            'INSERT INTO scheduled_messages (channel, recipient, message, image_path, schedule_time) VALUES ($1, $2, $3, $4, $5)',
            [channel, recipient, message || '', file ? file.path : null, scheduleTime]
        );

        res.json({ success: true, message: `បានកំណត់ពេលផ្ញើសារសម្រាប់ថ្ងៃទី ${scheduleTime} ជោគជ័យ!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ៦. API ទាញយក Logs
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Notification Hub Server កំពុងដំណើរការលើ http://localhost:${PORT}`);
});
