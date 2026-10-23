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
const sharp = require('sharp'); // នាំចូល sharp សម្រាប់កែច្នៃសរសេរអត្ថបទលើរូបភាព

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 🆕 កែសម្រួល multer ឱ្យទទួលរូបភាពច្រើន (រហូតដល់ ១០ រូប)
const upload = multer({ storage: multer.memoryStorage() });

// ១. ការតភ្ជាប់ Neon Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// បន្ថែម Error Handler ដើម្បីការពារកុំឱ្យ Node.js Crash ពេល Database ដាច់ការតភ្ជាប់
pool.on('error', (err, client) => {
    console.error('❌ Unexpected error on idle PostgreSQL client', err);
});

// ២. បង្កើតតារាងក្នុង Database បើមិនទាន់មាន (រួមទាំង Table groups សម្រាប់រក្សាទុក Group ថ្មី និង is_daily សម្រាប់សារប្រចាំថ្ងៃ)
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
                images_data TEXT, -- រក្សាទុកជា JSON string នៃ buffer និង mimetype រូបភាពច្រើន
                schedule_time TIMESTAMP WITH TIME ZONE NOT NULL,
                is_daily BOOLEAN DEFAULT false, -- 🆕 Column កំណត់សារស្វ័យប្រវត្តិរាល់ថ្ងៃ
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 🆕 បង្កើត Table សម្រាប់រក្សាទុកបញ្ជី Group
        await pool.query(`
            CREATE TABLE IF NOT EXISTS groups (
                id SERIAL PRIMARY KEY,
                group_id VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(150) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // ធានាថាតារាងមាន Column is_daily
        await pool.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS is_daily BOOLEAN DEFAULT false;`);

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

// ៥. WhatsApp Setup
const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});
whatsappClient.on('qr', (qr) => qrcode.generate(qr, { small: true }));
whatsappClient.on('ready', () => console.log('✅ [WhatsApp Client] រួចរាល់!'));
whatsappClient.initialize().catch(err => console.error('❌ [WhatsApp Error]:', err.message));

// ៦. LINE Bot Setup
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};
const lineClient = (lineConfig.channelAccessToken && !lineConfig.channelAccessToken.includes('YOUR_LINE'))
    ? new line.Client(lineConfig)
    : null;

// ៧. Core Function សម្រាប់បញ្ជូនសារ និងរូបភាពច្រើនតាម Platform
async function sendNotification(channel, recipient, message, imagesArray) {
    let tempFilePaths = [];
    
    try {
        // បង្កើត temporary files សម្រាប់រូបភាពនីមួយៗ
        if (imagesArray && imagesArray.length > 0) {
            for (let i = 0; i < imagesArray.length; i++) {
                const imgObj = imagesArray[i];
                // imgObj អាចជា object ដែលមាន buffer (from db) ឬ multer file object
                const buffer = imgObj.buffer?.type === 'Buffer' ? Buffer.from(imgObj.buffer.data) : (imgObj.buffer || imgObj);
                const mimetype = imgObj.mimetype || 'image/jpeg';
                const ext = mimetype.split('/')[1] || 'jpg';
                
                const tempFilePath = path.join(__dirname, `temp_${Date.now()}_${i}.${ext}`);
                fs.writeFileSync(tempFilePath, buffer);
                tempFilePaths.push({ path: tempFilePath, mimetype });
            }
        }

        // --- Telegram (គាំទ្រការផ្ញើ Chat ID ច្រើន និងរូបភាពច្រើន) ---
        if (channel === 'telegram' || channel === 'broadcast') {
            const rawTargets = recipient || process.env.TELEGRAM_GROUP_CHAT_ID || '';
            const targetIds = rawTargets.split(',').map(id => id.trim()).filter(id => id.length > 0);

            if (telegramBot && targetIds.length > 0) {
                for (const targetId of targetIds) {
                    try {
                        // ១. ផ្ញើអត្ថបទ (Message) ទៅមុន
                        if (message) {
                            await telegramBot.sendMessage(targetId, message, { parse_mode: 'HTML' });
                        }
                        // ២. ផ្ញើរូបភាពទាំងអស់តាមក្រោយ (អាចផ្ញើជា MediaGroup បើមានច្រើន ឬ sendPhoto ម្ដងមួយ)
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
            const cleanNumber = (recipient || '').replace(/[^0-9]/g, '');
            if (cleanNumber) {
                const formattedNumber = `${cleanNumber}@c.us`;
                // ១. ផ្ញើអត្ថបទ (Message) ទៅមុន
                if (message) {
                    await whatsappClient.sendMessage(formattedNumber, message);
                }
                // ២. ផ្ញើរូបភាពទាំងអស់តាមក្រោយ
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
            const targetLineId = recipient || process.env.LINE_USER_ID;
            if (targetLineId && lineClient) {
                const messages = [];
                if (message) messages.push({ type: 'text', text: message });
                if (messages.length > 0) {
                    await lineClient.pushMessage(targetLineId, messages);
                    await saveLog('LINE', targetLineId, message || '[Photos]', 'Success');
                }
            }
        }
    } finally {
        // លុប temporary files ចោលវិញក្រោយពេលផ្ញើចប់
        for (const fileObj of tempFilePaths) {
            if (fs.existsSync(fileObj.path)) {
                fs.unlinkSync(fileObj.path);
            }
        }
    }
}

// ៨. Logic ឆែកសាររង់ចាំ និងធ្វើការផ្ញើ (កែសម្រួលបន្ថែម Support Daily Auto-Send រាប់ថ្ងៃឡើង)
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
            let imagesArray = [];
            if (item.images_data) {
                imagesArray = JSON.parse(item.images_data);
            }

            // ១. ផ្ញើសារចេញទៅ
            await sendNotification(item.channel, item.recipient, item.message, imagesArray);

            // ២. ឆែកមើលបើជាសារប្រចាំថ្ងៃ (Daily Recurring) -> ថែម ១ ថ្ងៃ និង Update ថ្ងៃខែក្នុង Text ស្វ័យប្រវត្តិ
            if (item.is_daily) {
                // គណនាថ្ងៃស្អែក
                const currentScheduledDate = new Date(item.schedule_time);
                currentScheduledDate.setDate(currentScheduledDate.getDate() + 1);

                // កែប្រែថ្ងៃខែនៅក្នុងអត្ថបទអក្សរ (ប្រសិនបើមានទម្រង់ 23-10-2026)
                let updatedMessage = item.message;
                if (updatedMessage) {
                    const day = String(currentScheduledDate.getDate()).padStart(2, '0');
                    const month = String(currentScheduledDate.getMonth() + 1).padStart(2, '0');
                    const year = currentScheduledDate.getFullYear();
                    const newDateStr = `${day}-${month}-${year}`;

                    // រកជំនួស Regex ទម្រង់ DD-MM-YYYY
                    updatedMessage = updatedMessage.replace(/\b\d{2}-\d{2}-\d{4}\b/g, newDateStr);
                }

                await pool.query(
                    `UPDATE scheduled_messages 
                     SET schedule_time = schedule_time + INTERVAL '1 day', message = $1, status = 'Pending' 
                     WHERE id = $2`,
                    [updatedMessage, item.id]
                );
                console.log(`🔄 [Worker] Schedule ID ${item.id} ជាសារប្រចាំថ្ងៃ បានប្តូរទៅថ្ងៃស្អែក (${currentScheduledDate.toISOString()}) ដោយជោគជ័យ!`);
            } else {
                await pool.query("UPDATE scheduled_messages SET status = 'Sent' WHERE id = $1", [item.id]);
            }

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

// ១០. API ផ្ញើសារភ្លាមៗ (គាំទ្ររូបភាពច្រើន req.files)
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
        res.status(500).json({ success: false, error: err.message });
    }
});

// ១១. API បង្កើតកាលវិភាគផ្ញើសារ (Create Schedule) - គាំទ្រ Daily Auto-Send
app.post('/api/notify/schedule', upload.array('images', 10), async (req, res) => {
    const { channel, message, scheduleTime, phoneNumber, userId, isDaily } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;
    const isDailyBool = isDaily === 'true' || isDaily === true;

    if (!scheduleTime) {
        return res.status(400).json({ success: false, error: 'សូមកំណត់ពេលវេលាឱ្យបានត្រឹមត្រូវ!' });
    }

    try {
        const targetDate = new Date(scheduleTime + '+07:00');
        const imagesArray = req.files ? req.files.map(file => ({
            buffer: file.buffer,
            mimetype: file.mimetype
        })) : [];

        await pool.query(
            `INSERT INTO scheduled_messages 
             (channel, recipient, message, images_data, schedule_time, is_daily, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
            [
                channel,
                recipient,
                message || '',
                JSON.stringify(imagesArray),
                targetDate.toISOString(),
                isDailyBool
            ]
        );

        res.json({ success: true, message: `បានកំណត់ពេលផ្ញើសារសម្រាប់៖ ${scheduleTime} ${isDailyBool ? '(ផ្ញើស្វ័យប្រវត្តិរាល់ថ្ងៃ)' : ''} រួចរាល់!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 🆕 មុខងារបន្ថែម៖ API សម្រាប់បង្កើត និង ទាញយកបញ្ជី Group ពី Database
// -------------------------------------------------------------

// ១២. API ទាញយកបញ្ជី Group ទាំងអស់
app.get('/api/groups', async (req, res) => {
    try {
        const result = await pool.query("SELECT group_id as id, name FROM groups ORDER BY id DESC");
        res.json({
            success: true,
            groups: result.rows
        });
    } catch (err) {
        console.error('Error fetching groups:', err);
        res.status(500).json({ success: false, error: 'មិនអាចទាញយកបញ្ជីគ្រុបបានទេ' });
    }
});

// ១៣. API បង្កើត Group ថ្មីចូល Database
app.post('/api/groups', async (req, res) => {
    const { groupId, name } = req.body;
    if (!groupId || !name) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល Chat ID និងឈ្មោះ Group ឱ្យបានត្រឹមត្រូវ!' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO groups (group_id, name) VALUES ($1, $2) RETURNING *',
            [groupId, name]
        );
        res.json({ success: true, message: 'បានបង្កើត Group ថ្មីដោយជោគជ័យ!', group: result.rows[0] });
    } catch (err) {
        console.error('Error adding group:', err);
        res.status(500).json({ success: false, error: 'Group ID នេះមានរួចហើយ ឬមានបញ្ហាក្នុងការរក្សាទុក!' });
    }
});

// -------------------------------------------------------------
// មុខងារបន្ថែម៖ មើលបញ្ជី, កែប្រែ, និងលុប Schedule
// -------------------------------------------------------------

// ទាញយកបញ្ជីកាលវិភាគទាំងអស់ ព្រមទាំងឈ្មោះគ្រុប និងព័ត៌មាន is_daily
app.get('/api/schedules', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.channel, s.recipient, s.message, s.schedule_time, s.is_daily, s.status, s.created_at, 
                   g.name as group_name 
            FROM scheduled_messages s
            LEFT JOIN groups g ON s.recipient = g.group_id
            ORDER BY s.schedule_time DESC
        `);
        res.json({ success: true, schedules: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// កែប្រែព័ត៌មានកាលវិភាគ (Update Schedule) - គាំទ្រ Daily Auto-Send
app.put('/api/schedules/:id', upload.array('images', 10), async (req, res) => {
    const { id } = req.params;
    const { channel, message, scheduleTime, phoneNumber, userId, isDaily } = req.body;
    const recipient = phoneNumber || userId || process.env.TELEGRAM_GROUP_CHAT_ID;
    const isDailyBool = isDaily === 'true' || isDaily === true;

    try {
        const targetDate = new Date(scheduleTime + '+07:00');

        if (req.files && req.files.length > 0) {
            const imagesArray = req.files.map(file => ({
                buffer: file.buffer,
                mimetype: file.mimetype
            }));
            await pool.query(
                `UPDATE scheduled_messages 
                 SET channel = $1, recipient = $2, message = $3, images_data = $4, schedule_time = $5, is_daily = $6, status = 'Pending'
                 WHERE id = $7`,
                [channel, recipient, message, JSON.stringify(imagesArray), targetDate.toISOString(), isDailyBool, id]
            );
        } else {
            await pool.query(
                `UPDATE scheduled_messages 
                 SET channel = $1, recipient = $2, message = $3, schedule_time = $4, is_daily = $5, status = 'Pending'
                 WHERE id = $6`,
                [channel, recipient, message, targetDate.toISOString(), isDailyBool, id]
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server កំពុងរត់លើ http://localhost:${PORT}`));
