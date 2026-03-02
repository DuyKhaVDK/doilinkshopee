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

const FIREBASE_URL = process.env.FIREBASE_URL;
// Tự động xác định đường dẫn gốc của Database
const DB_ROOT = FIREBASE_URL.replace('stats.json', '');

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; 
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: GIẢI MÃ & LÀM SẠCH LINK (Khôi phục User-Agent đầy đủ) ---
async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    // Sử dụng User-Agent đầy đủ để Shopee không chặn lượt giải mã link
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10, timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
                validateStatus: null
            });
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) { console.log(`>> Lỗi giải mã: ${inputUrl}`); }
    }

    // Trích xuất Item ID chính xác từ URL đã giải mã
    const dashIMatch = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    const productPathMatch = finalUrl.match(/\/product\/\d+\/(\d+)/);
    const genericIdMatch = finalUrl.match(/(?:itemId=|\/product\/)(\d+)/);
    
    let itemId = null;
    if (dashIMatch) itemId = dashIMatch[2];
    else if (productPathMatch) itemId = productPathMatch[1];
    else if (genericIdMatch) itemId = genericIdMatch[1];
    else {
        const lastDigitMatch = finalUrl.match(/\/(\d+)(?:\?|$)/);
        itemId = lastDigitMatch ? lastDigitMatch[1] : null;
    }

    let cleanedUrl = finalUrl.split('?')[0];
    const match = cleanedUrl.match(/shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/);
    if (match) cleanedUrl = `https://shopee.vn/product/${match[2]}/${match[3]}`;

    return { cleanedUrl, itemId };
}

// --- HÀM 2: LẤY THÔNG TIN SẢN PHẨM (Đảm bảo trả về productName và imageUrl) ---
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
        // Trích xuất đúng cấu trúc dữ liệu Shopee
        return response.data.data?.productOfferV2?.nodes?.[0] || null;
    } catch (e) { return null; }
}

// --- HÀM 3: TẠO LINK RÚT GỌN ---
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

// --- ROUTER CHUYỂN ĐỔI LINK ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    if (!text) return res.status(400).json({ error: 'Nội dung trống' });

    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) return res.json({ success: false, converted: 0 });

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(url.startsWith('http') ? url : `https://${url}`);
        
        // Chạy song song: Tạo link rút gọn và Lấy thông tin sản phẩm
        const [short, info] = await Promise.all([
            getShopeeShortLink(cleanedUrl, subIds),
            getShopeeProductInfo(itemId)
        ]);

        return { 
            original: url, 
            short, 
            productName: info?.productName || "Sản phẩm Shopee", 
            imageUrl: info?.imageUrl || "" 
        };
    }));

    const successCount = conversions.filter(c => c.short).length;

    // --- CẬP NHẬT FIREBASE KÉP (STATS + DAILY) ---
    if (successCount > 0) {
        try {
            const now = new Date();
            const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); 
            
            const dbRes = await axios.get(`${DB_ROOT}.json`);
            const dbData = dbRes.data || {};
            const stats = dbData.stats || {};
            const dailyVal = dbData.daily?.[today] || 0;

            let newTotal = (stats.last_date !== today) ? successCount : (stats.total_converted || 0) + successCount;

            const updates = {
                stats: {
                    total_converted: newTotal,
                    last_date: today,
                    last_updated: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
                },
                [`daily/${today}`]: dailyVal + successCount
            };
            await axios.patch(`${DB_ROOT}.json`, updates);
        } catch (e) { console.error("Firebase Update Error:", e.message); }
    }

    let newText = text;
    conversions.forEach(item => { if (item.short) newText = newText.split(item.original).join(item.short); });
    res.json({ success: true, newText, converted: successCount, details: conversions });
});

router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || token !== ADMIN_SECRET) return res.status(403).json({ success: false, error: 'Mã bí mật!' });

    try {
        const response = await axios.get(`${DB_ROOT}.json`);
        const dbData = response.data || {};
        res.json({
            success: true,
            project: "HÔM NAY CÓ SALE KHÔNG?",
            total_converted_links: dbData.stats?.total_converted || 0,
            last_updated: dbData.stats?.last_updated || "Chưa có dữ liệu",
            daily: dbData.daily || {} 
        });
    } catch (e) { res.status(500).json({ success: false, error: "Lỗi DB" }); }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);
