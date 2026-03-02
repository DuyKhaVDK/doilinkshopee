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

// Biến môi trường từ Netlify
const FIREBASE_URL = process.env.FIREBASE_URL;
const DAILY_BASE_URL = process.env.DAILY_BASE_URL;

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; 
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1 & 2 & 3: GIỮ NGUYÊN LOGIC LÀM SẠCH VÀ LẤY INFO ---
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

// --- ROUTER CHUYỂN ĐỔI LINK & LOGIC RESET THEO NGÀY ---
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

    // --- LOGIC RESET THEO NGÀY ---
    if (successCount > 0) {
        try {
            const now = new Date();
            // Lấy ngày hiện tại định dạng YYYY-MM-DD theo múi giờ VN
            const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); 
            const dailyUrl = `${DAILY_BASE_URL}/${today}.json`;

            // 1. Lấy dữ liệu stats hiện tại
            const totalRes = await axios.get(FIREBASE_URL);
            const statsData = totalRes.data || {};
            
            let newTotal;
            // KIỂM TRA: Nếu ngày cuối cùng cập nhật KHÁC ngày hôm nay -> RESET về 0
            if (statsData.last_date !== today) {
                newTotal = successCount;
            } else {
                newTotal = (statsData.total_converted || 0) + successCount;
            }

            // 2. Cập nhật lại stats (số đếm trong ngày)
            await axios.patch(FIREBASE_URL, { 
                total_converted: newTotal,
                last_date: today, // Lưu lại ngày để so sánh cho lần sau
                last_updated: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
            });

            // 3. Vẫn lưu lịch sử vào mục daily (để bạn xem lại sau này nếu cần)
            const dailyRes = await axios.get(dailyUrl);
            const currentDaily = dailyRes.data || 0;
            await axios.put(dailyUrl, currentDaily + successCount);

        } catch (e) { console.error("Firebase Update Error:", e.message); }
    }

    let newText = text;
    conversions.forEach(item => { if (item.short) newText = newText.split(item.original).join(item.short); });
    res.json({ success: true, newText, converted: successCount, details: conversions });
});

// --- ROUTER ADMIN ---
router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || token !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Sai mật khẩu' });
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
