// functions/api.js

const express = require('express');
const serverless = require('serverless-http'); // Thư viện cầu nối Netlify
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const router = express.Router();

// --- CẤU HÌNH (BẠN ĐIỀN THÔNG TIN VÀO ĐÂY) ---
const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

// --- HÀM 1: GIẢI MÃ & LÀM SẠCH LINK (LOGIC PRO) ---
async function resolveAndCleanUrl(inputUrl) {
    let finalUrl = inputUrl;

    // 1. FOLLOW REDIRECT (Giải mã link rút gọn)
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            console.log(`>> Dang giai ma link: ${inputUrl}`);
            // THÊM: User-Agent để giả lập trình duyệt, tránh bị chặn trả về link login
            const response = await axios.get(inputUrl, {
                maxRedirects: 5,
                validateStatus: null,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
                }
            });
            finalUrl = response.request.res.responseUrl || inputUrl;
            console.log(`>> Link goc tim duoc: ${finalUrl}`);
        } catch (error) {
            console.log(`>> Khong the giai ma link: ${inputUrl}, giu nguyen.`);
        }
    }

    // 2. XỬ LÝ LÀM SẠCH THEO YÊU CẦU
    let baseUrl = finalUrl.split('?')[0]; 
    
    // --- CASE A: LOGIC CHO LINK SEARCH (WHITELIST) ---
    // SỬA: Đổi thứ tự ưu tiên để khớp với mong muốn của bạn
    // Thứ tự mới: mmp_pid -> promotionId -> signature -> các cái khác
    if (baseUrl.includes('/search')) {
        try {
            const urlObj = new URL(finalUrl);
            const originalParams = urlObj.searchParams;
            const newParams = new URLSearchParams();

            // SỬA: Danh sách tham số được phép giữ lại (Đã sắp xếp lại thứ tự)
            // Lưu ý: Code sẽ duyệt qua mảng này, gặp cái nào lấy cái đó => Thứ tự trong mảng quyết định thứ tự trong link kết quả
            const allowedKeys = ['mmp_pid', 'promotionId', 'signature', 'keyword', 'shop', 'evcode'];

            allowedKeys.forEach(key => {
                if (originalParams.has(key)) {
                    newParams.append(key, originalParams.get(key));
                }
            });

            // Nếu không còn tham số nào quan trọng thì trả về link gốc trơn
            if (newParams.toString() === "") return baseUrl;

            return `${baseUrl}?${newParams.toString()}`;

        } catch (e) {
            return baseUrl;
        }
    }

    // --- CASE B: LOGIC CHUYỂN ĐỔI SHOP -> PRODUCT ---
    // Ví dụ: shopee.vn/opaanlp/267075185/9253405547 -> /product/shopid/itemid
    const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
    const match = baseUrl.match(shopProductPattern);

    if (match) {
        // match[2] = shopid, match[3] = itemid
        return `https://shopee.vn/product/${match[2]}/${match[3]}`;
    }

    // --- CASE C: CẮT GỌN CHO CÁC LINK KHÁC ---
    // Gặp /m/ hoặc /product/ hoặc Link Shop -> Cắt hết params
    if (baseUrl.includes('/m/') || baseUrl.includes('/product/') || (baseUrl.split('/').length === 4)) {
        return baseUrl; 
    }

    // 3. LOGIC FALLBACK (Dành cho các link lạ)
    if (finalUrl.includes('uls_trackid=')) finalUrl = finalUrl.split('uls_trackid=')[0];
    if (finalUrl.includes('utm_source=')) finalUrl = finalUrl.split('utm_source=')[0];
    
    // Nếu không phải link search (đã xử lý ở trên) thì cắt mmp_pid để tránh trùng
    if (!finalUrl.includes('/search') && finalUrl.includes('mmp_pid=')) {
        finalUrl = finalUrl.split('mmp_pid=')[0];
    }
    
    if (finalUrl.endsWith('?') || finalUrl.endsWith('&')) {
        finalUrl = finalUrl.slice(0, -1);
    }

    return finalUrl;
}

// --- HÀM 2: GỌI API SHOPEE TẠO LINK AFFILIATE ---
async function getShopeeShortLink(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    // --- XỬ LÝ SUB_IDS ---
    let subIdsParam = "";
    if (subIds && subIds.length > 0) {
        // Lọc bỏ chuỗi rỗng và format thành chuỗi ["id1", "id2"]
        const validIds = subIds.filter(id => id && id.trim() !== "");
        if (validIds.length > 0) {
            const formattedIds = validIds.map(id => `"${id.trim()}"`).join(",");
            subIdsParam = `, subIds: [${formattedIds}]`;
        }
    }

    // Payload GraphQL
    const query = `mutation {
        generateShortLink(input: { 
            originUrl: "${originalUrl}"
            ${subIdsParam}
        }) {
            shortLink
        }
    }`;
    
    // Chuẩn bị Signature
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

        if (response.data.errors) {
            console.error('>> SHOPEE REFUSED:', JSON.stringify(response.data.errors, null, 2));
            return null;
        }
        return response.data.data.generateShortLink.shortLink;

    } catch (e) {
        console.error('>> API ERROR:', e.message);
        return null; 
    }
}

// --- ROUTER XỬ LÝ CHÍNH ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;

    if (!text) return res.status(400).json({ error: 'Empty text' });

    // Regex tìm link (bao gồm cả s.shopee.vn)
    const urlRegex = /(https?:\/\/(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) {
        return res.json({ success: true, newText: text, message: 'No links found', converted: 0 });
    }

    // Xử lý song song từng link
    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        // 1. Làm sạch input (bỏ dấu câu dính ở cuối)
        let cleanInput = url.replace(/[.,;!?)]+$/, ""); 
        
        // 2. Giải mã & Làm sạch link
        const realProductUrl = await resolveAndCleanUrl(cleanInput);

        // 3. Tạo link Affiliate (kèm SubID)
        const myShortLink = await getShopeeShortLink(realProductUrl, subIds);

        return { 
            original: url, 
            resolved: realProductUrl, // Link sạch dùng để debug
            short: myShortLink 
        };
    }));

    // Thay thế link trong văn bản gốc
    let newText = text;
    let successCount = 0;

    conversions.forEach(item => {
        if (item.short) {
            newText = newText.split(item.original).join(item.short);
            successCount++;
        }
    });

    // Trả kết quả về Frontend
    res.json({ 
        success: true, 
        newText, 
        totalLinks: uniqueLinks.length, 
        converted: successCount,
        details: conversions 
    });
});

// --- KẾT NỐI VỚI NETLIFY FUNCTIONS ---
app.use(cors());
app.use(bodyParser.json());

// Đường dẫn này phải khớp với cấu hình trong netlify.toml
app.use('/api', router); 

module.exports.handler = serverless(app);
