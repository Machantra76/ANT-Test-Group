require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const line = require('@line/bot-sdk');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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

pool.on('error', (err, client) => {
    console.error('❌ Unexpected error on idle PostgreSQL client', err);
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
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id SERIAL PRIMARY KEY,
                channel VARCHAR(50) NOT NULL,
                recipient TEXT,
                message TEXT,
                images_data TEXT,
                schedule_time TIMESTAMP WITH TIME ZONE NOT NULL,
                is_daily BOOLEAN DEFAULT false,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS groups (
                id SERIAL PRIMARY KEY,
                group_id VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(150) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS is_daily BOOLEAN DEFAULT false;`);
        console.log('✅ [Database] បានតភ្ជាប់ និងបង្កើត Tables រួចរាល់!');
    } catch (err) {
        console.error('❌ [Database Error]:', err.message);
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
        console.error('❌ [Log Save Error]:', err.message);
    }
}

// ៤. Telegram Bot Setup
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;
if (telegramToken && !telegramToken.includes('YOUR_TELEGRAM')) {
    try {
        telegramBot = new TelegramBot(telegramToken, { polling: true });
        telegramBot.on('polling_error', (error) => {
            console.log(`⚠️ Telegram Polling Warning:`, error.code);
        });
        console.log('✅ [Telegram Bot] តភ្ជាប់ជោគជ័យ!');
    } catch (err) {
        console.error('❌ [Telegram Setup Error]:', err.message);
    }
}

// ៥. WhatsApp Setup
let whatsappClient = null;
try {
    whatsappClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        }
    });
    whatsappClient.on('qr', (qr) => qrcode.generate(qr, { small: true }));
    whatsappClient.on('ready', () => console.log('✅ [WhatsApp Client] រួចរាល់!'));
    whatsappClient.initialize().catch(err => console.log('⚠️ [WhatsApp Warning]: គ្មាន Chrome លើ Server:', err.message));
} catch (wErr) {
    console.log('⚠️ WhatsApp client skipped:', wErr.message);
}

// ៦. LINE Bot Setup
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = (lineConfig.channelAccessToken && !lineConfig.channelAccessToken.includes('YOUR_LINE'))
    ? new line.Client(lineConfig)
    : null;

// ៧. Core Function សម្រាប់បញ្ជូនសារ
async function sendNotification(channel, recipient, message, imagesArray) {
    let tempFilePaths = [];
    
    try {
        if (imagesArray && imagesArray.length > 0) {
            for (let i = 0; i < imagesArray.length; i++) {
                const imgObj = imagesArray[i];
                const buffer = imgObj.buffer?.type === 'Buffer' ? Buffer.from(imgObj.buffer.data) : (imgObj.buffer || imgObj);
                const mimetype = imgObj.mimetype || 'image/jpeg';
                const ext = mimetype.split('/')[1] || 'jpg';
                
                const tempFilePath = path.join(__dirname, `temp_${Date.now()}_${i}.${ext}`);
                fs.writeFileSync(tempFilePath, buffer);
                tempFilePaths.push({ path: tempFilePath, mimetype });
            }
        }

        // --- Telegram ---
        if (channel === 'telegram' || channel === 'broadcast') {
            const rawTargets = recipient || process.env.TELEGRAM_GROUP_CHAT_ID || '';
            const targetIds = rawTargets.split(',').map(id => id.trim()).filter(id => id.length > 0);

            if (telegramBot && targetIds.length > 0) {
                for (const targetId of targetIds) {
                    try {
                        if (message) {
                            await telegramBot.sendMessage(targetId, message, { parse_mode: 'HTML' });
                        }
                        if (tempFilePaths.length > 0) {
                            for (const fileObj of tempFilePaths) {
                                await telegramBot.sendPhoto(targetId, fileObj.path);
                            }
                        }
                        await saveLog('Telegram', targetId, message || '[Photos]', 'Success');
                    } catch (singleErr) {
                        console.error(`❌ [Telegram Error for ID ${targetId}]:`, singleErr.message);
                        await saveLog('Telegram', targetId, message || '[Photos]', `Failed: ${singleErr.message}`);
                    }
                }
            }
        }

        // --- WhatsApp ---
        if (channel === 'whatsapp' || (channel === 'broadcast' && recipient)) {
            if (!whatsappClient) throw new Error('WhatsApp client មិនទាន់បើកដំណើរការ!');
            const cleanNumber = (recipient || '').replace(/[^0-9]/g, '');
            if (cleanNumber) {
                const formattedNumber = `${cleanNumber}@c.us`;
                if (message) {
                    await whatsappClient.sendMessage(formattedNumber, message);
                }
                for (const fileObj of tempFilePaths) {
                    const fileBuffer = fs.readFileSync(fileObj.path);
                    const media = new MessageMedia(fileObj.mimetype, fileBuffer.toString('base64'), 'image.jpg');
                    await whatsappClient.sendMessage(formattedNumber, media);
                }
                await saveLog('WhatsApp', recipient, message || '[Photos]', 'Success');
            }
        }

        // --- LINE ---
        if (channel === 'line' || channel === 'broadcast') {
            let targetLineId = recipient;
            if (!targetLineId || (!targetLineId.startsWith('U') && !targetLineId.startsWith('C'))) {
                targetLineId = process.env.LINE_USER_ID;
            }
            
            if (!lineClient) {
                throw new Error('LINE Client មិនទាន់ត្រូវបានកំណត់ cấu hình!');
            }
            if (!targetLineId) {
                throw new Error('រកមិនឃើញ LINE Target ID (User ID ឬ Group ID) សម្រាប់ផ្ញើសារ!');
            }

            const messages = [];
            if (message) messages.push({ type: 'text', text: message });

            if (messages.length > 0) {
                try {
                    await lineClient.pushMessage(targetLineId, messages);
                    await saveLog('LINE', targetLineId, message || '[Photos]', 'Success');
                    console.log(`✅ [LINE Success] បានផ្ញើសារទៅកាន់ Target ID: ${targetLineId}`);
                } catch (lineApiErr) {
                    console.error(`❌ [LINE API Error details]:`, lineApiErr.originalError?.response?.data || lineApiErr.message);
                    throw new Error(`LINE API Failed: ${lineApiErr.message}`);
                }
            }
        }
    } finally {
        for (const fileObj of tempFilePaths) {
            if (fs.existsSync(fileObj.path)) {
                fs.unlinkSync(fileObj.path);
            }
        }
    }
}

// ៨. Worker ឆែកសាររង់ចាំ (Cron Job Processing)
async function processPendingSchedules() {
    const result = await pool.query(
        `SELECT * FROM scheduled_messages WHERE status = 'Pending' AND schedule_time <= NOW()`
    );

    const pendingTasks = result.rows;
    if (pendingTasks.length === 0) return { count: 0 };

    let successCount = 0;
    for (const item of pendingTasks) {
        try {
            let imagesArray = item.images_data ? JSON.parse(item.images_data) : [];
            
            // 🚀 ផ្ញើសារចេញ (សារត្រូវបានទាញតម្លៃស្របតាម schedule_time ស្រាប់ពី Frontend)
            await sendNotification(item.channel, item.recipient, item.message, imagesArray);

            if (item.is_daily) {
                // 🔄 ប្រសិនបើជាសារប្រចាំថ្ងៃ ត្រូវបូកបន្ថែម ១ ថ្ងៃទៅឱ្យ "ម៉ោងផ្ញើ" សម្រាប់ថ្ងៃស្អែក
                const currentScheduledDate = new Date(item.schedule_time);
                currentScheduledDate.setDate(currentScheduledDate.getDate() + 1);

                // បច្ចុប្បន្នភាព schedule_time ថ្មី និងរក្សា status ជា Pending ដើម្បីឱ្យវាដេញឡើងរាល់ថ្ងៃ
                await pool.query(
                    `UPDATE scheduled_messages SET schedule_time = $1, status = 'Pending' WHERE id = $2`,
                    [currentScheduledDate.toISOString(), item.id]
                );
                console.log(`🔄 [Daily Schedule] បានអាប់ដេតម៉ោងផ្ញើសម្រាប់ថ្ងៃស្អែក៖ ${currentScheduledDate.toLocaleString()}`);
            } else {
                // ប្រសិនបើជាសារផ្ញើតែម្តង ប្តូរ status ទៅជា Sent
                await pool.query("UPDATE scheduled_messages SET status = 'Sent' WHERE id = $1", [item.id]);
            }
            successCount++;
        } catch (err) {
            console.error(`❌ [Schedule Error ID ${item.id}]:`, err.message);
            await pool.query("UPDATE scheduled_messages SET status = $1 WHERE id = $2", [`Failed: ${err.message}`, item.id]);
        }
    }
    return { count: pendingTasks.length, success: successCount };
}

app.get('/api/run-cron', async (req, res) => {
    try {
        const result = await processPendingSchedules();
        res.json({ success: true, message: `Cron executed. Processed: ${result.count}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ១០. API ផ្ញើសារភ្លាមៗ (Send Now)
app.post('/api/notify/send', upload.array('images', 10), async (req, res) => {
    const { channel, message, phoneNumber, userId } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;

    try {
        const imagesArray = req.files ? req.files.map(file => ({
            buffer: file.buffer,
            mimetype: file.mimetype
        })) : [];

        await sendNotification(channel, recipient, message, imagesArray);
        res.json({ success: true, message: 'បានបញ្ជូនសារនិងរូបភាពដោយជោគជ័យ!' });
    } catch (err) {
        console.error('❌ [API Send Error]:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// LINE Webhook Endpoint
app.post('/webhook', async (req, res) => {
    try {
        const events = req.body.events || [];
        for (const event of events) {
            if (event.source) {
                console.log(`📌 [LINE Webhook Source Type]: ${event.source.type}`);
                if (event.source.groupId) {
                    console.log(`🎯 [LINE GROUP ID រកឃើញ]: ${event.source.groupId}`);
                }
                if (event.source.userId) {
                    console.log(`👤 [LINE User ID]: ${event.source.userId}`);
                }
            }
        }
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('❌ [Webhook Error]:', err);
        res.status(200).json({ success: false });
    }
});

app.post('/api/notify/schedule', upload.array('images', 10), async (req, res) => {
    const { channel, message, scheduleTime, phoneNumber, userId, isDaily } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;
    const isDailyBool = isDaily === 'true' || isDaily === true;

    if (!scheduleTime) return res.status(400).json({ success: false, error: 'សូមកំណត់ពេលវេលាឱ្យបានត្រឹមត្រូវ!' });

    try {
        const targetDate = new Date(scheduleTime + '+07:00');
        const imagesArray = req.files ? req.files.map(file => ({
            buffer: file.buffer,
            mimetype: file.mimetype
        })) : [];

        await pool.query(
            `INSERT INTO scheduled_messages (channel, recipient, message, images_data, schedule_time, is_daily, status) VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
            [channel, recipient, message || '', JSON.stringify(imagesArray), targetDate.toISOString(), isDailyBool]
        );

        res.json({ success: true, message: 'បានកំណត់ពេលផ្ញើសារជោគជ័យ!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/groups', async (req, res) => {
    try {
        const result = await pool.query("SELECT group_id as id, name FROM groups ORDER BY id DESC");
        res.json({ success: true, groups: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/groups', async (req, res) => {
    const { groupId, name } = req.body;
    try {
        const result = await pool.query('INSERT INTO groups (group_id, name) VALUES ($1, $2) RETURNING *', [groupId, name]);
        res.json({ success: true, group: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/schedules', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.channel, s.recipient, s.message, s.schedule_time, s.is_daily, s.status, s.created_at, g.name as group_name 
            FROM scheduled_messages s LEFT JOIN groups g ON s.recipient = g.group_id ORDER BY s.schedule_time DESC
        `);
        res.json({ success: true, schedules: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/schedules/:id', upload.array('images', 10), async (req, res) => {
    const { id } = req.params;
    const { channel, message, scheduleTime, phoneNumber, userId, isDaily } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;
    const isDailyBool = isDaily === 'true' || isDaily === true;
    try {
        const targetDate = new Date(scheduleTime + '+07:00');
        await pool.query(
            `UPDATE scheduled_messages SET channel = $1, recipient = $2, message = $3, schedule_time = $4, is_daily = $5, status = 'Pending' WHERE id = $6`,
            [channel, recipient, message, targetDate.toISOString(), isDailyBool, id]
        );
        res.json({ success: true, message: 'បានកែប្រែកាលវិភាគជោគជ័យ!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/schedules/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'បានលុបជោគជ័យ!' });
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server កំពុងរត់លើ http://localhost:${PORT}`));
