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

// --- HÀM 1: LÀM SẠCH LINK & TRÍCH XUẤT ITEM ID ---
async function resolveAndCleanUrl(inputUrl) {
    let finalUrl = inputUrl;
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
    const cleanUrl = finalUrl.split('?')[0].replace(/[.,;!?)]+$/, "");
    
    // Trích xuất ItemId từ URL (Ví dụ: ...-i.123.456 hoặc /product/123/456)
    const match = cleanUrl.match(/(?:-i\.|\/product\/)\d+[\.\/](\d+)/);
    const itemId = match ? match[1] : null;

    return { cleanUrl, itemId };
}

// --- HÀM 2: LẤY THÔNG TIN SẢN PHẨM (TÊN & ẢNH) ---
async function getShopeeProductInfo(itemId) {
    if (!itemId) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    // Sử dụng Query productOfferV2 từ tài liệu bạn gửi
    const query = `query { productOfferV2(itemId: ${itemId}) { nodes { productName imageUrl } } }`;
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256').update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`).digest('hex');

    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });
        const nodes = response.data.data?.productOfferV2?.nodes;
        return nodes && nodes.length > 0 ? nodes[0] : null;
    } catch (e) { return null; }
}

// --- HÀM 3: TẠO LINK RÚT GỌN ---
async function getShopeeShortLink(originalUrl, userSubIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    let finalSubIds = ["webchuyendoi"]; 
    if (userSubIds && userSubIds.length > 0) {
        const validUserIds = userSubIds.filter(id => id && id.trim() !== "" && id !== "webchuyendoi");
        finalSubIds = [...finalSubIds, ...validUserIds].slice(0, 5);
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
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        const { cleanUrl, itemId } = await resolveAndCleanUrl(fullUrl);
        
        // Chạy song song lấy link và lấy thông tin sản phẩm để tối ưu tốc độ
        const [short, info] = await Promise.all([
            getShopeeShortLink(cleanUrl, subIds),
            getShopeeProductInfo(itemId)
        ]);

        return { 
            short,
            productName: info?.productName || "",
            imageUrl: info?.imageUrl || ""
        };
    }));

    res.json({ success: true, converted: conversions.filter(c => c.short).length, details: conversions });
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);
