// netlify/functions/api.js
require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');
// Thay đổi đoạn require cũ thành đoạn này:
const blobs = require('@netlify/blobs');
const getStore = blobs.getStore; 

// Thêm một dòng kiểm tra để không bị sập server nếu lỗi thư viện
if (typeof getStore !== 'function') {
    console.error("LỖI: Không thể tìm thấy hàm getStore. Hãy kiểm tra lại phiên bản @netlify/blobs!");
}
const app = express();
const router = express.Router();

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; // Mã bí mật để xem thống kê
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: GIẢI MÃ, TRÍCH XUẤT ID & LÀM SẠCH LINK ---
async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    
    // A. GIẢI MÃ REDIRECT (Follow Redirect cho link rút gọn)
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10,
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
                validateStatus: null
            });
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) {
            console.log(`>> Lỗi giải mã: ${inputUrl}`);
        }
    }

    // B. TRÍCH XUẤT ITEM ID
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

    // C. LOGIC LÀM SẠCH LINK
    let cleanedUrl = finalUrl;
    let baseUrl = finalUrl.split('?')[0];

    if (baseUrl.includes('/search')) {
        try {
            const urlObj = new URL(finalUrl);
            const newParams = new URLSearchParams();
            const allowedKeys = ['keyword', 'shop', 'evcode', 'signature', 'promotionId', 'mmp_pid'];
            allowedKeys.forEach(key => {
                if (urlObj.searchParams.has(key)) newParams.append(key, urlObj.searchParams.get(key));
            });
            cleanedUrl = newParams.toString() ? `${baseUrl}?${newParams.toString()}` : baseUrl;
        } catch (e) { cleanedUrl = baseUrl; }
    } else {
        const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
        const match = baseUrl.match(shopProductPattern);
        if (match) {
            cleanedUrl = `https://shopee.vn/product/${match[2]}/${match[3]}`;
        } else if (baseUrl.includes('/m/') || baseUrl.includes('/product/') || (baseUrl.split('/').length === 4)) {
            cleanedUrl = baseUrl;
        } else {
            let tempUrl = finalUrl;
            ['uls_trackid=', 'utm_source=', 'mmp_pid='].forEach(p => {
                if (tempUrl.includes(p)) tempUrl = tempUrl.split(p)[0];
            });
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
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });
        return response.data.data?.productOfferV2?.nodes?.[0] || null;
    } catch (e) { return null; }
}

// --- HÀM 3: TẠO LINK RÚT GỌN (KÈM SUBID) ---
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
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });
        return response.data.data?.generateShortLink?.shortLink || null;
    } catch (e) { return null; }
}

// --- ROUTER 1: XỬ LÝ CHUYỂN ĐỔI LINK ---
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

    const successfulConversions = conversions.filter(c => c.short).length;

    // Cập nhật số liệu thống kê vào Blobs
    if (successfulConversions > 0) {
        try {
            const statsStore = getStore('link_stats');
            let currentTotal = await statsStore.get('total_converted', { type: 'json' }) || 0;
            await statsStore.setJSON('total_converted', currentTotal + successfulConversions);
        } catch (e) {
            console.error("Lỗi cập nhật Blobs:", e);
        }
    }

    let newText = text;
    conversions.forEach(item => {
        if (item.short) newText = newText.split(item.original).join(item.short);
    });

    res.json({ 
        success: true, 
        newText,
        converted: successfulConversions, 
        details: conversions 
    });
});

// --- ROUTER 2: XEM THỐNG KÊ (DÀNH CHO ADMIN) ---
router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
// THÊM DÒNG NÀY ĐỂ KIỂM TRA TRONG TERMINAL
    console.log("Mật khẩu nhận được:", token);
    console.log("Mật khẩu trong hệ thống:", ADMIN_SECRET);
    if (!token || token !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Truy cập bị từ chối!' });
    }

    try {
        const statsStore = getStore('link_stats');
        const total = await statsStore.get('total_converted', { type: 'json' }) || 0;
        res.json({
            success: true,
            project: "HÔM NAY CÓ SALE KHÔNG?",
            total_converted_links: total,
            last_updated: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Lỗi khi truy xuất dữ liệu' });
    }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);

module.exports.handler = serverless(app);
