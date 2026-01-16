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

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: LÀM SẠCH LINK CƠ BẢN (TỐI GIẢN ĐỂ CHẠY NHANH) ---
async function resolveAndCleanUrl(inputUrl) {
    let finalUrl = inputUrl;
    // Chỉ giải mã nếu là link rút gọn, không quét HTML để tránh bị Shopee chặn
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 5, 
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0' } 
            });
            finalUrl = response.request.res.responseUrl || inputUrl;
        } catch (e) { console.log("Lỗi giải mã link"); }
    }
    return finalUrl.split('?')[0].replace(/[.,;!?)]+$/, "");
}

// --- HÀM 2: GỌI API SHOPEE (GẮN MẶC ĐỊNH SUB_ID1) ---
async function getShopeeShortLink(originalUrl, userSubIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    // GẮN MẶC ĐỊNH: Luôn ưu tiên 'webchuyendoi' ở vị trí đầu tiên
    let finalSubIds = ["webchuyendoi"]; 
    
    // Nếu người dùng có nhập thêm SubID ở giao diện, ta nối tiếp vào sau
    if (userSubIds && userSubIds.length > 0) {
        const validUserIds = userSubIds.filter(id => id && id.trim() !== "" && id !== "webchuyendoi");
        finalSubIds = [...finalSubIds, ...validUserIds].slice(0, 5); // Shopee cho tối đa 5 SubID
    }

    const formattedIds = finalSubIds.map(id => `"${id.trim()}"`).join(",");
    const query = `mutation { generateShortLink(input: { originUrl: "${originalUrl}", subIds: [${formattedIds}] }) { shortLink } }`;
    
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256').update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`).digest('hex');

    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });
        return response.data.data ? response.data.data.generateShortLink.shortLink : null;
    } catch (e) { return null; }
}

router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const uniqueLinks = [...new Set(text.match(urlRegex) || [])];

    if (uniqueLinks.length === 0) return res.json({ success: false });

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const cleanUrl = await resolveAndCleanUrl(url.startsWith('http') ? url : `https://${url}`);
        const short = await getShopeeShortLink(cleanUrl, subIds);
        return { short };
    }));

    res.json({ success: true, converted: conversions.filter(c => c.short).length, details: conversions });
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);