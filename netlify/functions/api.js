// netlify/functions/api.js
require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');

// --- PHẦN SỬA LỖI TRIỆT ĐỂ CHO BLOBS ---
const blobs_lib = require('@netlify/blobs');
// Truy tìm getStore ở mọi ngóc ngách (môi trường Netlify đôi khi để ở .default)
const getStore = blobs_lib.getStore || (blobs_lib.default && blobs_lib.default.getStore);

const app = express();
const router = express.Router();

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// Log kiểm tra khi khởi động
if (typeof getStore !== 'function') {
    console.error("⚠️ CẢNH BÁO: Vẫn không thấy getStore. Danh sách hàm đang có:", Object.keys(blobs_lib));
} else {
    console.log("✅ HỆ THỐNG: Hàm getStore đã được tìm thấy thành công.");
}

// --- HÀM 1: GIẢI MÃ, TRÍCH XUẤT ID & LÀM SẠCH LINK ---
async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10,
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
                validateStatus: null
            });
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) { console.log(`>> Lỗi giải mã: ${inputUrl}`); }
    }
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
    let cleanedUrl = finalUrl;
    let baseUrl = finalUrl.split('?')[0];
    if (baseUrl.includes('/search')) {
        try {
            const urlObj = new URL(finalUrl);
            const newParams = new URLSearchParams();
            const allowedKeys = ['keyword', 'shop', 'evcode', 'signature', 'promotionId', 'mmp_pid'];
            allowedKeys.forEach(key => { if (urlObj.searchParams.has(key)) newParams.append(key, urlObj.searchParams.get(key)); });
            cleanedUrl = newParams.toString() ? `${baseUrl}?${newParams.toString()}` : baseUrl;
        } catch (e) { cleanedUrl = baseUrl; }
    } else {
        const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
        const match = baseUrl.match(shopProductPattern);
        if (match) { cleanedUrl = `https://shopee.vn/product/${match[2]}/${match[3]}`; } 
        else if (baseUrl.includes('/m/') || baseUrl.includes('/product/') || (baseUrl.split('/').length === 4)) { cleanedUrl = baseUrl; } 
        else {
            let tempUrl = finalUrl;
            ['uls_trackid=', 'utm_source=', 'mmp_pid='].forEach(p => { if (tempUrl.includes(p)) tempUrl = tempUrl.split(p)[0]; });
            if (tempUrl.endsWith('?') || tempUrl.endsWith('&')) tempUrl = tempUrl.slice(0, -1);
            cleanedUrl = tempUrl;
        }
    }
    return { cleanedUrl, itemId };
}

// --- HÀM 2: LẤY THÔNG TIN SẢN PHẨM ---
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

// --- HÀM 3: TẠO LINK RÚT GỌN ---
async function getShopeeShortLink(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    let finalSubIds = ["webchuyendoi"]; 
    if (subIds && subIds.length > 0) {
        const validIds = subIds.filter(id => id && id.trim() !== "");
        if (validIds.length > 0) finalSubIds = validIds.map(id => id.trim());
    }
    const formattedIds = finalSubIds.map(id => `"${id}"`).join(",");
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

// --- ROUTER 1: CHUYỂN ĐỔI LINK ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    if (!text) return res.status(400).json({ error: 'Nội dung trống' });
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];
    if (uniqueLinks.length === 0) return res.json({ success: false, converted: 0 });
    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(fullUrl);
        const [short, info] = await Promise.all([ getShopeeShortLink(cleanedUrl, subIds), getShopeeProductInfo(itemId) ]);
        return { original: url, short, productName: info?.productName || "Sản phẩm Shopee", imageUrl: info?.imageUrl || "" };
    }));
    const successCount = conversions.filter(c => c.short).length;
    if (successCount > 0 && typeof getStore === 'function') {
        try {
            const statsStore = getStore('link_stats');
            let currentTotal = await statsStore.get('total_converted', { type: 'json' }) || 0;
            await statsStore.setJSON('total_converted', currentTotal + successCount);
        } catch (e) { console.error("Lỗi đếm link:", e.message); }
    }
    res.json({ success: true, converted: successCount, details: conversions });
});

// --- ROUTER 2: XEM THỐNG KÊ (ADMIN) ---
router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
    console.log("Mật khẩu nhận được:", token);
    console.log("Mật khẩu trong hệ thống:", ADMIN_SECRET);
    if (!token || token !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Mã bí mật không đúng!' });
    }
    try {
        if (typeof getStore !== 'function') { throw new Error("Thư viện lưu trữ chưa sẵn sàng."); }
        const statsStore = getStore('link_stats');
        const total = await statsStore.get('total_converted', { type: 'json' }) || 0;
        res.json({ success: true, project: "HÔM NAY CÓ SALE KHÔNG?", total_converted_links: total, last_updated: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) });
    } catch (e) {
        console.error("LỖI ADMIN:", e.message);
        res.status(500).json({ success: false, error: "Lỗi hệ thống: " + e.message });
    }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);
