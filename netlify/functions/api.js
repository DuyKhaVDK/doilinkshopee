
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
const DB_ROOT = process.env.DB_ROOT;

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; 
const AFF_ID_22 = process.env.AFF_ID || "17396720247"; 
const AFF_ID_25_750 = "17318770053"; 
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (/(s\.shopee\.vn|shp\.ee|s\.shope\.ee|vn\.shp\.ee|shope\.ee)/.test(inputUrl)) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10, timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
                validateStatus: null
            });
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) { console.log(`>> Lỗi giải mã: ${inputUrl}`); }
    }
    const dashIMatch = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    const productPathMatch = finalUrl.match(/\/product\/\d+\/(\d+)/);
    const genericIdMatch = finalUrl.match(/(?:itemId=|\/product\/)(\d+)/);
    let itemId = dashIMatch ? dashIMatch[2] : (productPathMatch ? productPathMatch[1] : (genericIdMatch ? genericIdMatch[1] : null));
    if (!itemId) {
        const lastDigitMatch = finalUrl.match(/\/(\d+)(?:\?|$)/);
        itemId = lastDigitMatch ? lastDigitMatch[1] : null;
    }
    let cleanedUrl = finalUrl.split('?')[0];
    const match = cleanedUrl.match(/shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/);
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

async function getShopeeShortLink25(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    const finalSubIds = (Array.isArray(subIds) && subIds.length > 0) ? subIds : ["DK25"]; 
    const query = `mutation { generateShortLink(input: { originUrl: "${originalUrl}", subIds: [${finalSubIds.map(id => `"${id.trim()}"`).join(",")}] }) { shortLink } }`;
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256').update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`).digest('hex');
    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}` }
        });
        return response.data.data?.generateShortLink?.shortLink || null;
    } catch (e) { return null; }
}

function generateUniversalLink22(originalUrl, subIds = []) {
    const encodedUrl = encodeURIComponent(originalUrl);
    const subId = (Array.isArray(subIds) && subIds.length > 0) ? subIds.join('-') : "DK22";
    return `https://s.shopee.vn/an_redir?origin_link=${encodedUrl}&affiliate_id=${AFF_ID_22}&sub_id=${subId}`;
}

// Hàm mới cho công cụ số 3
function generateUniversalLink25_750(originalUrl) {
    const encodedUrl = encodeURIComponent(originalUrl);
    return `https://s.shopee.vn/an_redir?origin_link=${encodedUrl}&affiliate_id=${AFF_ID_25_750}&sub_id=DK`;
}

router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn|s\.shope\.ee|shope\.ee)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];
    if (uniqueLinks.length === 0) return res.json({ success: false, converted: 0 });
    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(url.startsWith('http') ? url : `https://${url}`);
        const [link25, info] = await Promise.all([ getShopeeShortLink25(cleanedUrl, subIds), getShopeeProductInfo(itemId) ]);
        const link22 = generateUniversalLink22(cleanedUrl, subIds);
        const link25_750 = generateUniversalLink25_750(cleanedUrl); 
        return { 
            productName: info?.productName || "Sản phẩm Shopee", 
            imageUrl: info?.imageUrl || "", 
            short25: link25, 
            short22: link22,
            short25_750: link25_750 
        };
    }));
    res.json({ success: true, converted: conversions.length, details: conversions });
});

router.post('/track-click', async (req, res) => {
    const { type } = req.body; 
    if (!type) return res.json({ success: false });
    try {
        const now = new Date();
        const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); 
        const dbRes = await axios.get(`${DB_ROOT}.json`);
        const dbData = dbRes.data || {};
        const stats = dbData.stats || {};
        const dailyVal = dbData.daily?.[today] || { count_25: 0, count_22: 0, "25%750K": 0 }; 
        
        let reset = stats.last_date !== today;
        const updates = {};
        if (reset) {
            updates.stats = {
                total_25: type === '25' ? 1 : 0,
                total_22: type === '22' ? 1 : 0,
                "25%750K": type === '25%750K' ? 1 : 0, 
                last_date: today,
                last_updated: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
            };
        } else {
           
            const field = type === '25%750K' ? "25%750K" : `total_${type}`;
            updates[`stats/${field}`] = (stats[field] || 0) + 1;
            updates[`stats/last_updated`] = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        }
        const dailyField = type === '25%750K' ? "25%750K" : `count_${type}`;
        updates[`daily/${today}/${dailyField}`] = (dailyVal[dailyField] || 0) + 1;
        await axios.patch(`${DB_ROOT}.json`, updates);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token !== ADMIN_SECRET) return res.status(403).json({ success: false });
    try {
        const response = await axios.get(`${DB_ROOT}.json`);
        res.json({ success: true, data: response.data || {} });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);
