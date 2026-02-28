// netlify/functions/api.js
require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const router = express.Router();

// --- BƯỚC QUAN TRỌNG: THAY LINK FIREBASE CỦA BẠN VÀO ĐÂY ---
const FIREBASE_URL = "https://doilinkshopee-default-rtdb.asia-southeast1.firebasedatabase.app/";

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; 
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: GIẢI MÃ & LÀM SẠCH LINK (LOGIC CỦA DUY KHA) ---
async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10, timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0...' },
                validateStatus: null
            });
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) { console.log(`Lỗi giải mã: ${inputUrl}`); }
    }
    const dashIMatch = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    const genericIdMatch = finalUrl.match(/(?:itemId=|\/product\/)(\d+)/);
    let itemId = dashIMatch ? dashIMatch[2] : (genericIdMatch ? genericIdMatch[1] : null);

    let baseUrl = finalUrl.split('?')[0];
    let cleanedUrl = baseUrl;
    const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
    const match = baseUrl.match(shopProductPattern);
    if (match) cleanedUrl = `https://shopee.vn/product/${match[2]}/${match[3]}`;

    return { cleanedUrl, itemId };
}

// --- HÀM 2: LẤY THÔNG TIN & TẠO LINK (Giữ nguyên) ---
async function getShopeeProductInfo(itemId) {
    if (!itemId) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const query = `query { productOfferV2(itemId: ${itemId}) { nodes { productName imageUrl } } }`;
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256').update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`).digest('hex');
    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}` }
        });
        return response.data.data?.productOfferV2?.nodes?.[0] || null;
    } catch (e) { return null; }
}

async function getShopeeShortLink(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    let finalSubIds = subIds.length > 0 ? subIds : ["webchuyendoi"]; 
    const formattedIds = finalSubIds.map(id => `"${id.trim()}"`).join(",");
    const query = `mutation { generateShortLink(input: { originUrl: "${originalUrl}", subIds: [${formattedIds}] }) { shortLink } }`;
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256').update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`).digest('hex');
    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}` }
        });
        return response.data.data?.generateShortLink?.shortLink || null;
    } catch (e) { return null; }
}

// --- ROUTER CHÍNH: CHUYỂN ĐỔI & LƯU VÀO FIREBASE ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) return res.json({ success: false, converted: 0 });

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(url.startsWith('http') ? url : `https://${url}`);
        const [short, info] = await Promise.all([ getShopeeShortLink(cleanedUrl, subIds), getShopeeProductInfo(itemId) ]);
        return { original: url, short, productName: info?.productName || "Sản phẩm Shopee", imageUrl: info?.imageUrl || "" };
    }));

    const successCount = conversions.filter(c => c.short).length;

    // CẬP NHẬT SỐ LIỆU VÀO FIREBASE (ĐOẠN CÒN THIẾU CỦA BẠN)
    if (successCount > 0) {
        try {
            const firebaseRes = await axios.get(FIREBASE_URL);
            const currentTotal = firebaseRes.data?.total_converted || 0;
            await axios.patch(FIREBASE_URL, { 
                total_converted: currentTotal + successCount,
                last_updated: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
            });
        } catch (e) { console.error("Lỗi cập nhật số liệu:", e.message); }
    }

    let newText = text;
    conversions.forEach(item => { if (item.short) newText = newText.split(item.original).join(item.short); });
    res.json({ success: true, newText, converted: successCount, details: conversions });
});

// --- ROUTER ADMIN: XEM BÁO CÁO ---
router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || token !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Mã bí mật không đúng!' });
    }
    try {
        const response = await axios.get(FIREBASE_URL);
        res.json({
            success: true,
            project: "HÔM NAY CÓ SALE KHÔNG?",
            total_converted_links: response.data?.total_converted || 0,
            last_updated: response.data?.last_updated || "Chưa có dữ liệu"
        });
    } catch (e) { res.status(500).json({ success: false, error: "Lỗi kết nối database" }); }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);
