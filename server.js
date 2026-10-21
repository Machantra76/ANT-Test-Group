require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const line = require('@line/bot-sdk');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// ១. ការតភ្ជាប់ Neon Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ២. បង្កើតតារាងក្នុង Database បើមិនទាន់មាន
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notification_logs (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50),
                recipient TEXT,
                message TEXT,
                status VARCHAR(50),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50) NOT NULL,
                recipient TEXT,
                message TEXT,
                image_data BYTEA,
                image_mimetype VARCHAR(100),
                schedule_time TIMESTAMP WITH TIME ZONE NOT NULL,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ [Database] បានតភ្ជាប់ និងបង្កើត Tables រួចរាល់!');
    } catch (err) {
        console.error('❌ [Database Error]:', err.message);
    }
}
initDatabase();

// ៣. រក្សាទុក Logs
async function saveLog(channel, recipient, message, status) {
    try {
        await pool.query(
            'INSERT INTO notification_logs (channel, recipient, message, status) VALUES ($1, $2, $3, $4)',
            [channel, recipient, message, status]
        );
    } catch (err) {
        console.error('❌ [Log Save Error]:', err.message);
    }
}

// ៤. Telegram Bot Setup
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;
if (telegramToken && !telegramToken.includes('YOUR_TELEGRAM')) {
    telegramBot = new TelegramBot(telegramToken, { polling: true });
    console.log('✅ [Telegram Bot] តភ្ជាប់ជោគជ័យ!');
}

// ៥. WhatsApp Setup (កែសម្រួលប្រើ puppeteer.executablePath ឱ្យស្គាល់ Chrome លើ Render ស្វ័យប្រវត្តិ)
// ៥. WhatsApp Setup (កំណត់កូដបែប Safe Mode)
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

whatsappClient.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('📱 [WhatsApp] សូមស្កេន QR Code នេះដើម្បីតភ្ជាប់!');
});

whatsappClient.on('ready', () => console.log('✅ [WhatsApp Client] រួចរាល់!'));

// បន្ថែម Error Handler ដើម្បីកុំឱ្យ Server គាំង (Crash) ពេល WhatsApp មានបញ្ហា
whatsappClient.initialize().catch(err => {
    console.error('⚠️ [WhatsApp Warning]: មិនអាចដំណើរការ WhatsApp Client បានទេ ប៉ុន្តែ Server នៅតែបន្តដំណើរការធម្មតា។ Error:', err.message);
});
// ៦. LINE Bot Setup
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = (lineConfig.channelAccessToken && !lineConfig.channelAccessToken.includes('YOUR_LINE'))
    ? new line.Client(lineConfig)
    : null;

// ៧. Core Function សម្រាប់បញ្ជូនសារតាម Platform
async function sendNotification(channel, recipient, message, fileBuffer, fileMime) {
    let tempFilePath = null;
    if (fileBuffer) {
        const ext = fileMime ? fileMime.split('/')[1] : 'jpg';
        tempFilePath = path.join(__dirname, `temp_${Date.now()}.${ext}`);
        fs.writeFileSync(tempFilePath, fileBuffer);
    }

    try {
        // --- Telegram ---
        if (channel === 'telegram' || channel === 'broadcast') {
            const targetId = recipient || process.env.TELEGRAM_GROUP_CHAT_ID;
            if (targetId && telegramBot) {
                if (tempFilePath) {
                    await telegramBot.sendPhoto(targetId, tempFilePath, { caption: message || '', parse_mode: 'HTML' });
                } else {
                    await telegramBot.sendMessage(targetId, message || '', { parse_mode: 'HTML' });
                }
                await saveLog('Telegram', targetId, message || '[Photo]', 'Success');
            }
        }

        // --- WhatsApp ---
        if (channel === 'whatsapp' || (channel === 'broadcast' && recipient)) {
            const cleanNumber = (recipient || '').replace(/[^0-9]/g, '');
            if (cleanNumber) {
                const formattedNumber = `${cleanNumber}@c.us`;
                if (fileBuffer) {
                    const media = new MessageMedia(fileMime, fileBuffer.toString('base64'), 'image.jpg');
                    await whatsappClient.sendMessage(formattedNumber, media, { caption: message || '' });
                } else {
                    await whatsappClient.sendMessage(formattedNumber, message);
                }
                await saveLog('WhatsApp', recipient, message || '[Photo]', 'Success');
            }
        }

        // --- LINE ---
        if (channel === 'line' || channel === 'broadcast') {
            const targetLineId = recipient || process.env.LINE_USER_ID;
            if (targetLineId && lineClient) {
                const messages = [];
                if (message) messages.push({ type: 'text', text: message });
                if (messages.length > 0) {
                    await lineClient.pushMessage(targetLineId, messages);
                    await saveLog('LINE', targetLineId, message || '[Photo]', 'Success');
                }
            }
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
    }
}

// ៨. Logic ឆែកសាររង់ចាំ និងធ្វើការផ្ញើ
async function processPendingSchedules() {
    const result = await pool.query(
        `SELECT * FROM scheduled_messages WHERE status = 'Pending' AND schedule_time <= NOW()`
    );

    const pendingTasks = result.rows;
    if (pendingTasks.length === 0) {
        return { count: 0 };
    }

    console.log(`⏰ [Worker] រកឃើញសារស្វ័យប្រវត្តិចំនួន ${pendingTasks.length} ត្រូវផ្ញើ!`);

    let successCount = 0;
    for (const item of pendingTasks) {
        try {
            await sendNotification(item.channel, item.recipient, item.message, item.image_data, item.image_mimetype);
            await pool.query("UPDATE scheduled_messages SET status = 'Sent' WHERE id = $1", [item.id]);
            console.log(`✅ [Worker] ផ្ញើសារ Schedule ID ${item.id} ជោគជ័យ!`);
            successCount++;
        } catch (err) {
            console.error(`❌ [Worker Error] Schedule ID ${item.id}:`, err.message);
            await pool.query("UPDATE scheduled_messages SET status = $1 WHERE id = $2", [`Failed: ${err.message}`, item.id]);
        }
    }
    return { count: pendingTasks.length, success: successCount };
}

// ៩. API Endpoint សម្រាប់ Cron Worker
app.get('/api/run-cron', async (req, res) => {
    try {
        const result = await processPendingSchedules();
        res.json({
            success: true,
            message: `Cron executed. Processed: ${result.count}`,
            timestamp: new Date()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ១០. API ផ្ញើសារភ្លាមៗ
app.post('/api/notify/send', upload.single('image'), async (req, res) => {
    const { channel, message, phoneNumber, userId } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    try {
        await sendNotification(
            channel,
            recipient,
            message,
            req.file ? req.file.buffer : null,
            req.file ? req.file.mimetype : null
        );
        res.json({ success: true, message: 'បានបញ្ជូនសារដោយជោគជ័យ!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ១១. API បង្កើតកាលវិភាគផ្ញើសារ (Create Schedule) - កែសម្រួល Timezone ឱ្យត្រូវម៉ោងកម្ពុជា (+07:00)
app.post('/api/notify/schedule', upload.single('image'), async (req, res) => {
    const { channel, message, scheduleTime, phoneNumber, userId } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    if (!scheduleTime) {
        return res.status(400).json({ success: false, error: 'សូមកំណត់ពេលវេលាឱ្យបានត្រឹមត្រូវ!' });
    }

    try {
        const targetDate = new Date(scheduleTime + '+07:00');

        await pool.query(
            `INSERT INTO scheduled_messages 
             (channel, recipient, message, image_data, image_mimetype, schedule_time, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
            [
                channel,
                recipient,
                message || '',
                req.file ? req.file.buffer : null,
                req.file ? req.file.mimetype : null,
                targetDate.toISOString()
            ]
        );

        res.json({ success: true, message: `បានកំណត់ពេលផ្ញើសារសម្រាប់៖ ${scheduleTime} រួចរាល់!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 🆕 មុខងារបន្ថែម៖ មើលបញ្ជី, កែប្រែ, និងលុប Schedule
// -------------------------------------------------------------

// ទាញយកបញ្ជីកាលវិភាគទាំងអស់ (Get All Schedules)
app.get('/api/schedules', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, channel, recipient, message, schedule_time, status, created_at FROM scheduled_messages ORDER BY schedule_time DESC'
        );
        res.json({ success: true, schedules: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// កែប្រែព័ត៌មានកាលវិភាគ (Update Schedule) - កែសម្រួល Timezone ឱ្យត្រូវម៉ោងកម្ពុជា (+07:00)
app.put('/api/schedules/:id', upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const { channel, message, scheduleTime, phoneNumber, userId } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    try {
        const targetDate = new Date(scheduleTime + '+07:00');

        if (req.file) {
            await pool.query(
                `UPDATE scheduled_messages 
                 SET channel = $1, recipient = $2, message = $3, image_data = $4, image_mimetype = $5, schedule_time = $6, status = 'Pending'
                 WHERE id = $7`,
                [channel, recipient, message, req.file.buffer, req.file.mimetype, targetDate.toISOString(), id]
            );
        } else {
            await pool.query(
                `UPDATE scheduled_messages 
                 SET channel = $1, recipient = $2, message = $3, schedule_time = $4, status = 'Pending'
                 WHERE id = $5`,
                [channel, recipient, message, targetDate.toISOString(), id]
            );
        }

        res.json({ success: true, message: 'បានកែប្រែកាលវិភាគដោយជោគជ័យ!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// លុបកាលវិភាគ (Delete Schedule)
app.delete('/api/schedules/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
        res.json({ success: true, message: 'បានលុបកាលវិភាគជោគជ័យ!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API ទាញយក Logs
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Server កំពុងរត់លើ http://localhost:${PORT}`));
