// functions/api.js

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

// --- HÀM HỖ TRỢ: GIẢI MÃ LINK RÚT GỌN (CHUYÊN SÂU) ---
async function unshortenLink(url) {
    try {
        const response = await axios.get(url, {
            maxRedirects: 0, // QUAN TRỌNG: Không tự động chuyển hướng
            validateStatus: (status) => status >= 200 && status < 400, // Chấp nhận 301, 302
            headers: {
                // Giả lập trình duyệt thật để Shopee không chặn
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 5000 
        });

        // Nếu server trả về header Location (link đích), lấy nó ngay
        if (response.headers.location) {
            let nextUrl = response.headers.location;
            // Nếu location là đường dẫn tương đối (bắt đầu bằng /), ghép domain vào
            if (nextUrl.startsWith('/')) {
                const urlObj = new URL(url);
                nextUrl = `${urlObj.origin}${nextUrl}`;
            }
            return nextUrl;
        }
        
        // Nếu không có Location, trả về URL gốc
        return url;
    } catch (error) {
        // Lỗi kết nối thì giữ nguyên link
        return url;
    }
}

// --- HÀM 1: XỬ LÝ CHÍNH ---
async function resolveAndCleanUrl(inputUrl) {
    let finalUrl = inputUrl;

    // 1. GIẢI MÃ LINK (Thử tối đa 2 lần redirect nếu cần)
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        console.log(`>> Dang giai ma: ${inputUrl}`);
        finalUrl = await unshortenLink(finalUrl);
        
        // Đề phòng trường hợp redirect 2 lớp (s.shopee -> shp.ee -> shopee.vn)
        if (finalUrl.includes('shp.ee') || finalUrl.includes('s.shopee.vn')) {
            finalUrl = await unshortenLink(finalUrl);
        }
        console.log(`>> Link da giai ma: ${finalUrl}`);
    }

    // 2. LÀM SẠCH VÀ SẮP XẾP THAM SỐ
    let baseUrl = finalUrl.split('?')[0]; 
    
    // --- CASE A: LINK SEARCH (QUAN TRỌNG: SẮP XẾP ĐÚNG THỨ TỰ BẠN CẦN) ---
    // Thứ tự mong muốn: mmp_pid -> promotionId -> signature -> keyword...
    if (baseUrl.includes('/search')) {
        try {
            const urlObj = new URL(finalUrl);
            const originalParams = urlObj.searchParams;
            const newParams = new URLSearchParams();

            // Mảng quyết định thứ tự xuất hiện trong link kết quả
            const allowedKeys = ['mmp_pid', 'promotionId', 'signature', 'keyword', 'shop', 'evcode'];

            allowedKeys.forEach(key => {
                if (originalParams.has(key)) {
                    newParams.append(key, originalParams.get(key));
                }
            });

            if (newParams.toString() === "") return baseUrl;
            return `${baseUrl}?${newParams.toString()}`;

        } catch (e) {
            return baseUrl;
        }
    }

    // --- CASE B: SHOP -> PRODUCT ---
    const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
    const match = baseUrl.match(shopProductPattern);
    if (match) {
        return `https://shopee.vn/product/${match[2]}/${match[3]}`;
    }

    // --- CASE C: DỌN RÁC ---
    if (baseUrl.includes('/m/') || baseUrl.includes('/product/') || (baseUrl.split('/').length === 4)) {
        return baseUrl; 
    }

    if (finalUrl.includes('uls_trackid=')) finalUrl = finalUrl.split('uls_trackid=')[0];
    if (finalUrl.includes('utm_source=')) finalUrl = finalUrl.split('utm_source=')[0];
    
    // Nếu KHÔNG phải link search thì xóa mmp_pid cho đỡ rối
    if (!finalUrl.includes('/search') && finalUrl.includes('mmp_pid=')) {
        finalUrl = finalUrl.split('mmp_pid=')[0];
    }
    
    if (finalUrl.endsWith('?') || finalUrl.endsWith('&')) finalUrl = finalUrl.slice(0, -1);

    return finalUrl;
}

// --- HÀM 2: GỌI API SHOPEE ---
async function getShopeeShortLink(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    let subIdsParam = "";
    if (subIds && subIds.length > 0) {
        const validIds = subIds.filter(id => id && id.trim() !== "");
        if (validIds.length > 0) {
            const formattedIds = validIds.map(id => `"${id.trim()}"`).join(",");
            subIdsParam = `, subIds: [${formattedIds}]`;
        }
    }

    const query = `mutation {
        generateShortLink(input: { 
            originUrl: "${originalUrl}"
            ${subIdsParam}
        }) {
            shortLink
        }
    }`;
    
    const payloadObject = { query };
    const payloadString = JSON.stringify(payloadObject);
    const stringToSign = `${APP_ID}${timestamp}${payloadString}${APP_SECRET}`;
    const signature = crypto.createHash('sha256').update(stringToSign).digest('hex');

    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            }
        });

        if (response.data.errors) return null;
        return response.data.data.generateShortLink.shortLink;

    } catch (e) {
        return null; 
    }
}

// --- ROUTER ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    if (!text) return res.status(400).json({ error: 'Empty text' });

    const urlRegex = /(https?:\/\/(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) {
        return res.json({ success: true, newText: text, message: 'No links found', converted: 0 });
    }

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        let cleanInput = url.replace(/[.,;!?)]+$/, ""); 
        const realProductUrl = await resolveAndCleanUrl(cleanInput);
        const myShortLink = await getShopeeShortLink(realProductUrl, subIds);

        return { 
            original: url, 
            resolved: realProductUrl, 
            short: myShortLink 
        };
    }));

    let newText = text;
    let successCount = 0;
    conversions.forEach(item => {
        if (item.short) {
            newText = newText.split(item.original).join(item.short);
            successCount++;
        }
    });

    res.json({ success: true, newText, totalLinks: uniqueLinks.length, converted: successCount, details: conversions });
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router); 

module.exports.handler = serverless(app);
