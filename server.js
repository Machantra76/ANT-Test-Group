require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const line = require('@line/bot-sdk');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ១. TELEGRAM BOT INITIALIZATION
// ==========================================
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;

if (telegramToken && telegramToken !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    telegramBot = new TelegramBot(telegramToken, { polling: true });
    console.log('បានភ្ជាប់ទៅកាន់ Telegram Bot ដោយជោគជ័យ!');

    telegramBot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const chatTitle = msg.chat.title || 'Private Chat';
        console.log(`Telegram Notification - Chat ID: ${chatId} | Title/Name: "${chatTitle}"`);
    });
} else {
    console.log('សូមកំណត់ TELEGRAM_BOT_TOKEN នៅក្នុងឯកសារ .env');
}

// ==========================================
// 🟢 កំណត់ម៉ោងស្វ័យប្រវត្តិផ្ញើសារ (ថ្ងៃទី 20-10-2026 ម៉ោង 22:58)
// ទម្រង់ Cron: 58 22 20 10 *
// ==========================================
cron.schedule('58 22 20 10 *', async () => {
    console.log('កំពុងដំណើរការផ្ញើសារស្វ័យប្រវត្តិទៅ Telegram Group...');
    const targetChatId = process.env.TELEGRAM_GROUP_CHAT_ID;

    if (telegramBot && targetChatId && targetChatId !== '-100XXXXXXXXXX') {
        try {
            await telegramBot.sendMessage(targetChatId, 'Hi', { parse_mode: 'HTML' });
            console.log('បានផ្ញើសារស្វ័យប្រវត្តិ "Hi" ចូល Group ដោយជោគជ័យ!');
        } catch (err) {
            console.error('កំហុសในการផ្ញើសារស្វ័យប្រវត្តិ:', err.message);
        }
    } else {
        console.log('Telegram Bot ឬ Group Chat ID មិនទាន់ត្រឹមត្រូវសម្រាប់ការផ្ញើអូតូ!');
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
    console.log('សូមស្កេន QR Code ខាងក្រោមនៅលើ WhatsApp ទូរស័ព្ទរបស់អ្នក៖');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.log('បានភ្ជាប់ទៅកាន់ WhatsApp Web Client រួចរាល់!');
});

whatsappClient.initialize();

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
app.post('/api/notify/telegram', async (req, res) => {
    const { chatId, message } = req.body;
    const targetChatId = chatId || process.env.TELEGRAM_GROUP_CHAT_ID;

    if (!telegramBot) {
        return res.status(400).json({ success: false, error: 'Telegram Bot មិនទាន់ត្រូវបានរៀបចំក្នុង .env ទេ!' });
    }

    if (!targetChatId || targetChatId === '-100XXXXXXXXXX') {
        return res.status(400).json({ success: false, error: 'សូមបញ្ជាក់ ឬកំណត់ Chat ID របស់ Telegram Group ក្នុង .env!' });
    }

    try {
        await telegramBot.sendMessage(targetChatId, message, { parse_mode: 'HTML' });
        res.json({ success: true, message: 'បានផ្ញើសារទៅ Telegram Group ដោយជោគជ័យ!' });
    } catch (err) {
        console.error('Error sending Telegram message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/notify/whatsapp', async (req, res) => {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល លេខទូរស័ព្ទ និង អត្ថបទសារ!' });
    }

    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const formattedNumber = `${cleanNumber}@c.us`;
        await whatsappClient.sendMessage(formattedNumber, message);
        res.json({ success: true, message: 'បានផ្ញើសារទៅ WhatsApp ដោយជោគជ័យ!' });
    } catch (err) {
        console.error('Error sending WhatsApp message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/notify/line', async (req, res) => {
    const { userId, message } = req.body;

    if (!userId || !message) {
        return res.status(400).json({ success: false, error: 'សូមបញ្ចូល LINE User ID និង អត្ថបទសារ!' });
    }

    try {
        await lineClient.pushMessage(userId, { type: 'text', text: message });
        res.json({ success: true, message: 'បានផ្ញើសារទៅ LINE ដោយជោគជ័យ!' });
    } catch (err) {
        console.error('Error sending LINE message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/notify/broadcast', async (req, res) => {
    const { message, telegramChatId, whatsappPhone, lineUserId } = req.body;
    const status = {};

    if (telegramBot) {
        const tChatId = telegramChatId || process.env.TELEGRAM_GROUP_CHAT_ID;
        try {
            await telegramBot.sendMessage(tChatId, message, { parse_mode: 'HTML' });
            status.telegram = 'ជោគជ័យ (Success)';
        } catch (e) {
            status.telegram = `បរាជ័យ: ${e.message}`;
        }
    }

    if (whatsappPhone) {
        try {
            const cleanNumber = whatsappPhone.replace(/[^0-9]/g, '');
            await whatsappClient.sendMessage(`${cleanNumber}@c.us`, message);
            status.whatsapp = 'ជោគជ័យ (Success)';
        } catch (e) {
            status.whatsapp = `បរាជ័យ: ${e.message}`;
        }
    }

    if (lineUserId && lineConfig.channelAccessToken) {
        try {
            await lineClient.pushMessage(lineUserId, { type: 'text', text: message });
            status.line = 'ជោគជ័យ (Success)';
        } catch (e) {
            status.line = `បរាជ័យ: ${e.message}`;
        }
    }

    res.json({ success: true, status });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Notification Hub Server កំពុងដំណើរការលើ http://localhost:${PORT}`);
});