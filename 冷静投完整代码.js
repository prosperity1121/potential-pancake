// ==========================================
// 1. 系统配置与去机器化 Prompt
// ==========================================
const API_KEY_STORAGE_KEY = 'calmInvestDeepSeekApiKey';
const API_URL = 'https://api.deepseek.com/chat/completions';
const NEWS_PROXY_URL = 'https://api.allorigins.win/get?url=';

const systemPrompt = `你是一个名为“冷静投”的AI智能体，专门在个人投资者交易前执行行为金融学纠偏。
【极其重要的场景判定】
在回答前，你必须先判断用户的意图：
- 场景A（日常问答/闲聊）：用户只是在问理论、规则或闲聊。请直接以专业友好的自然语言作答，**绝对不要**输出任何带有 "[偏误评分]" 的字眼。
- 场景B（交易与决策）：用户有明确的交易、持仓困惑或个股分析意图。你必须在回答的第一行严格按此格式输出：[偏误评分] 偏误名称1:分数, 偏误名称2:分数

（注意：分数0-100。偏误名称必须根据用户实际情况，从“外推偏差、处置效应、有限注意、过度自信、羊群效应、博彩偏好、损失厌恶、证实偏差、组合忽视、心理账户、锚定效应”中精准匹配1-3个，切勿每次都一样！）

【时间与事实约束】
如果用户问到“今天几号、星期几、现在是不是某天、最近几天”等时间事实，你必须优先依据用户消息中提供的[系统时间锚点]作答，禁止自行猜测日期，必须明确写出具体日期。

【文字诊断要求 (仅限场景B)】
1. 结合[补充联网行情数据]，点明用户的盈亏现状或标的风险。
2. 解释你为什么给出上述偏误评分，指出用户决策逻辑的漏洞。
3. 强制反方思考(Consider-the-opposite)：列出至少2条“如果市场与你预期相反”的可能情况。
4. 给出最终的冷静期建议。
（全程禁止使用机械的模块标题，语言要像人一样对话，使用 Markdown 加粗关键信息）`;

// ==========================================
// 全局状态与会话管理
// ==========================================
let currentUser = ""; let sessions = []; let currentSessionId = null; let currentConversationHistory = [];

const welcomeScreen = document.getElementById('welcome-screen');
const chatContainer = document.getElementById('chat-container');
const agentStatus = document.getElementById('agent-status');
const statusText = document.getElementById('status-text');
const mainInput = document.getElementById('main-input');
const sendBtn = document.getElementById('send-btn');
const paramsContent = document.getElementById('params-content');
const sessionHistoryList = document.getElementById('session-history-list');
const apiKeyBtn = document.getElementById('api-key-btn');

window.onload = function() { checkLogin(); };

function getStoredApiKey() {
    return (localStorage.getItem(API_KEY_STORAGE_KEY) || '').trim();
}

function refreshApiKeyButton() {
    if (!apiKeyBtn) return;
    apiKeyBtn.innerText = getStoredApiKey() ? '已配置 Key' : '配置 Key';
}

function ensureApiKey(forcePrompt = false) {
    const currentKey = getStoredApiKey();
    if (currentKey && !forcePrompt) return currentKey;

    const userInput = window.prompt(
        currentKey
            ? '请输入新的 DeepSeek API Key。留空并取消可保留当前 Key。'
            : '首次使用请输入 DeepSeek API Key。该 Key 只会保存在当前浏览器的 localStorage 中。'
    );

    if (userInput === null) return forcePrompt ? currentKey : '';

    const nextKey = userInput.trim();
    if (!nextKey) {
        alert('API Key 不能为空。');
        return currentKey;
    }

    localStorage.setItem(API_KEY_STORAGE_KEY, nextKey);
    refreshApiKeyButton();
    return nextKey;
}

function configureApiKey() {
    const beforeKey = getStoredApiKey();
    const afterKey = ensureApiKey(true);
    if (afterKey && afterKey !== beforeKey) alert('API Key 已更新并保存到本地浏览器。');
    refreshApiKeyButton();
}

function getCurrentTimeContext() {
    const now = new Date();
    const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}，${weekdayNames[now.getDay()]}，时区 ${timezone}`;
}

function decodeHtmlEntities(str) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
}

function stripHtmlTags(str) {
    return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function formatNewsDate(dateStr) {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '';
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
}

async function fetchStockNews(code, stockName) {
    const keyword = stockName ? `${stockName} 股票` : `${code} 股票`;
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword + ' when:7d')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    try {
        const response = await fetch(`${NEWS_PROXY_URL}${encodeURIComponent(rssUrl)}`);
        if (!response.ok) return [];
        const proxyData = await response.json();
        const xmlText = proxyData.contents || '';
        if (!xmlText) return [];

        const xmlDoc = new DOMParser().parseFromString(xmlText, 'text/xml');
        const items = Array.from(xmlDoc.querySelectorAll('item')).slice(0, 3);
        return items.map(item => {
            const title = decodeHtmlEntities(stripHtmlTags(item.querySelector('title')?.textContent || ''));
            const link = item.querySelector('link')?.textContent || '';
            const pubDateRaw = item.querySelector('pubDate')?.textContent || '';
            return {
                title,
                link,
                pubDate: formatNewsDate(pubDateRaw),
            };
        }).filter(item => item.title);
    } catch (e) {
        return [];
    }
}

function renderNewsDigest(newsItems, stockLabel) {
    if (!newsItems || newsItems.length === 0) return '';
    const title = stockLabel ? `${stockLabel} 近日新闻速览` : '近日新闻速览';
    const itemsHtml = newsItems.map(item => {
        const safeTitle = item.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeDate = (item.pubDate || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeLink = (item.link || '').replace(/"/g, '&quot;');
        const metaHtml = safeDate ? `<div style="font-size:12px; color:#6b7280; margin-top:4px;">${safeDate}</div>` : '';
        const linkHtml = safeLink ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8; text-decoration:none;">${safeTitle}</a>` : safeTitle;
        return `<li style="margin-bottom:10px;">${linkHtml}${metaHtml}</li>`;
    }).join('');

    return `<div class="bias-dashboard" style="margin-bottom:18px;">
                <div class="dash-title">📰 ${title}</div>
                <ul style="margin:0; padding-left:18px;">${itemsHtml}</ul>
            </div>`;
}

function checkLogin() {
    currentUser = localStorage.getItem('calmInvestUser');
    if (!currentUser) document.getElementById('login-overlay').style.display = 'flex';
    else {
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('display-name').innerText = "👨‍💻 " + currentUser;
        refreshApiKeyButton();
        loadSessions();
        if (!getStoredApiKey()) ensureApiKey();
    }
}

function doLogin() {
    const name = document.getElementById('login-name').value.trim();
    if (name) { localStorage.setItem('calmInvestUser', name); checkLogin(); }
}
function logout() { localStorage.removeItem('calmInvestUser'); checkLogin(); }

function loadSessions() {
    sessions = JSON.parse(localStorage.getItem('calmInvestSessions_' + currentUser)) || [];
    renderSessionList();
    if (sessions.length > 0) switchSession(sessions[0].id);
    else startNewChat();
}

function renderSessionList() {
    sessionHistoryList.innerHTML = '';
    sessions.forEach(session => {
        const div = document.createElement('div');
        div.className = `history-item ${session.id === currentSessionId ? 'active' : ''}`;
        div.onclick = () => switchSession(session.id);
        let tags = (session.biases || []).map(b => `<div class="tag">${b}</div>`).join('');
        div.innerHTML = `<b>${session.title || '新交易决策'}</b> <span style="color:#aaa; font-size:11px; float:right;">${session.date}</span><br>${tags}`;
        sessionHistoryList.appendChild(div);
    });
}

function startNewChat() {
    currentSessionId = Date.now();
    currentConversationHistory = [{ role: "system", content: systemPrompt }];
    Array.from(chatContainer.children).forEach(child => { if (child.id !== 'agent-status') child.style.display = 'none'; });
    welcomeScreen.style.display = 'flex'; chatContainer.style.display = 'none';
    sessions.unshift({ id: currentSessionId, title: '新的诊断...', date: new Date().toLocaleDateString(), biases: [], html: '', context: currentConversationHistory });
    saveSessionsToLocal(); renderSessionList();
}

function switchSession(id) {
    currentSessionId = id; const session = sessions.find(s => s.id === id);
    if (session) {
        welcomeScreen.style.display = 'none'; chatContainer.style.display = 'flex';
        Array.from(chatContainer.children).forEach(child => { if (child.id !== 'agent-status') child.remove(); });
        const tempDiv = document.createElement('div'); tempDiv.innerHTML = session.html;
        Array.from(tempDiv.children).forEach(node => { chatContainer.insertBefore(node, agentStatus); });
        currentConversationHistory = session.context; chatContainer.scrollTop = chatContainer.scrollHeight; renderSessionList();
    }
}

function updateCurrentSession(title, biases) {
    const session = sessions.find(s => s.id === currentSessionId);
    if (session) {
        if (title) session.title = title; if (biases) session.biases = biases;
        let currentHtml = '';
        Array.from(chatContainer.children).forEach(child => { if (child.id !== 'agent-status' && child.style.display !== 'none') currentHtml += child.outerHTML; });
        session.html = currentHtml; session.context = currentConversationHistory;
        saveSessionsToLocal(); renderSessionList();
    }
}
function saveSessionsToLocal() { localStorage.setItem('calmInvestSessions_' + currentUser, JSON.stringify(sessions)); }
function clearAllHistory() { if (confirm('确定要清空所有复盘记录吗？')) { sessions = []; saveSessionsToLocal(); startNewChat(); } }

function toggleParams() { const isHidden = paramsContent.style.display === '' || paramsContent.style.display === 'none'; paramsContent.style.display = isHidden ? 'flex' : 'none'; document.querySelector('.params-header').innerText = isHidden ? '▼ 收起交易参数台' : '▶ 展开交易参数台'; }
function fillInput(text) { mainInput.value = text; mainInput.focus(); }
function sendMsgDirectly(text) { mainInput.value = text; submitMessage(); }
function handleEnter(e) { if (e.key === 'Enter') submitMessage(); }

function addTxRow() {
    const row = document.createElement('div'); row.className = 'dynamic-row tx-row';
    row.innerHTML = `<input type="text" class="param-input tx-code" placeholder="证券代码 (如: 300475)" style="flex: 1.5;"><select class="param-input tx-action" style="flex: 1;"><option value="">操作类型</option><option value="买入">买入</option><option value="卖出">卖出</option><option value="加仓">加仓</option><option value="减仓">减仓</option></select><input type="number" class="param-input tx-amount" placeholder="数量" style="flex: 1;"><input type="text" class="param-input tx-loss" placeholder="承受亏损%" style="flex: 1;"><button class="remove-row-btn" onclick="this.parentElement.remove()">×</button>`;
    document.getElementById('tx-rows-container').appendChild(row);
}

async function fetchStockPrice(code) {
    if (!code || code.length !== 6) return null; let prefix = (code.startsWith('6') || code.startsWith('9')) ? 'sh' : 'sz';
    try {
        const response = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent('http://qt.gtimg.cn/q=' + prefix + code)}`);
        if (!response.ok) return null;
        const resData = await response.json();
        const dataArr = resData.contents.split('~');
        if (dataArr.length > 5) return { name: dataArr[1], price: dataArr[3], change: dataArr[32] };
    } catch (e) {}
    return null;
}

// ==========================================
// 主流式获取逻辑
// ==========================================
async function submitMessage() {
    let text = mainInput.value.trim(); if (!text) return;
    const apiKey = ensureApiKey();
    if (!apiKey) {
        alert('未检测到 API Key，无法发起智能诊断。');
        return;
    }

    let allDetectedCodes = []; let matchCodes = text.match(/[0-9]{6}/g);
    if (matchCodes) allDetectedCodes = allDetectedCodes.concat(matchCodes);
    const holdingRawText = document.getElementById('param-holdings-paste').value.trim();
    if (holdingRawText) { let hCodes = holdingRawText.match(/[0-9]{6}/g); if (hCodes) allDetectedCodes = allDetectedCodes.concat(hCodes); }

    let txDetails = []; let primaryCode = "";
    document.querySelectorAll('.tx-row').forEach(row => {
        const code = row.querySelector('.tx-code').value.trim(); const action = row.querySelector('.tx-action').value;
        if (code) {
            allDetectedCodes.push(code); if (!primaryCode) primaryCode = code;
            txDetails.push(`拟操作:${code}, 动作:${action || '未知'}, 数量:${row.querySelector('.tx-amount').value || '未填'}`);
        }
    });
    if (!primaryCode && allDetectedCodes.length > 0) primaryCode = allDetectedCodes[0];
    const displayTitle = primaryCode ? `${primaryCode} 诊断` : "快速诊断";

    welcomeScreen.style.display = 'none'; chatContainer.style.display = 'flex';
    appendUserMessage(text);
    mainInput.value = ''; mainInput.disabled = true; sendBtn.disabled = true;
    agentStatus.style.display = 'flex'; chatContainer.appendChild(agentStatus);

    statusText.innerText = '正在并发获取全网真实行情...';
    let uniqueCodes = [...new Set(allDetectedCodes)];
    let fetchPromises = uniqueCodes.map(code => fetchStockPrice(code));
    let results = await Promise.all(fetchPromises);
    let realTimeMarketData = [];
    let stockDataMap = {};
    results.forEach((data, index) => {
        if (data) {
            stockDataMap[uniqueCodes[index]] = data;
            realTimeMarketData.push(`代码:${uniqueCodes[index]}, 名称:${data.name}, 现价:${data.price}元, 涨幅:${data.change}%`);
        }
    });

    statusText.innerText = '正在汇总近日新闻与时间锚点...';
    const primaryStockData = primaryCode ? stockDataMap[primaryCode] : null;
    const primaryStockLabel = primaryCode ? `${primaryStockData?.name || '股票'}（${primaryCode}）` : '';
    const newsItems = primaryCode ? await fetchStockNews(primaryCode, primaryStockData?.name) : [];

    statusText.innerText = '正在计算偏误指数...';

    let extraContext = "\n\n[补充环境参数]";
    extraContext += `\n[系统时间锚点]: ${getCurrentTimeContext()}`;
    if (holdingRawText) extraContext += `\n持仓表:\n${holdingRawText}`;
    if (txDetails.length > 0) extraContext += `\n交易计划:\n${txDetails.join('\n')}`;
    if (realTimeMarketData.length > 0) extraContext += `\n[今日真实行情]:\n- ${realTimeMarketData.join('\n- ')}`;
    if (newsItems.length > 0) extraContext += `\n[近日相关新闻]:\n- ${newsItems.map(item => `${item.pubDate ? item.pubDate + ' | ' : ''}${item.title}`).join('\n- ')}`;

    currentConversationHistory.push({ role: "user", content: text + extraContext });

    const aiMsgDiv = document.createElement('div'); aiMsgDiv.className = `message ai-msg`;
    chatContainer.insertBefore(aiMsgDiv, agentStatus);

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages: currentConversationHistory, temperature: 0.6, stream: true })
        });
        if (!response.ok) throw new Error("API 请求失败");
        agentStatus.style.display = 'none';

        const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8'); let aiFullText = '';
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            const lines = decoder.decode(value, { stream: true }).split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.choices[0].delta.content) {
                            aiFullText += data.choices[0].delta.content;
                            aiMsgDiv.innerHTML = parseMarkdownWithDashboard(aiFullText);
                            chatContainer.scrollTop = chatContainer.scrollHeight;
                        }
                    } catch (e) {}
                }
            }
        }

        if (newsItems.length > 0) aiMsgDiv.innerHTML = renderNewsDigest(newsItems, primaryStockLabel) + parseMarkdownWithDashboard(aiFullText);
        currentConversationHistory.push({ role: "assistant", content: aiFullText });

        let detectedBiases = [];
        // 智能意图分流：只有当大模型输出了评分标签，才说明这是一次真实交易，才会显示闭环按钮
        if (aiFullText.includes('[偏误评分]')) {
            appendFeedbackAndDecision(aiMsgDiv);
            const biasKeywords = ["外推偏差", "处置效应", "有限注意", "过度自信", "羊群效应", "博彩偏好", "损失厌恶", "证实偏差", "组合忽视", "锚定效应", "心理账户"];
            biasKeywords.forEach(b => { if (aiFullText.includes(b)) detectedBiases.push(b); });
            if (detectedBiases.length === 0) detectedBiases.push("潜在偏误");
        } else {
            // 如果是闲聊，左侧历史记录打上专属标签
            detectedBiases.push("日常问答");
        }

        updateCurrentSession(displayTitle, detectedBiases);

    } catch (error) {
        agentStatus.style.display = 'none'; aiMsgDiv.innerHTML = `系统接入异常：${error.message}`;
    } finally { mainInput.disabled = false; sendBtn.disabled = false; mainInput.focus(); }
}

function appendUserMessage(text) {
    const msgDiv = document.createElement('div'); msgDiv.className = `message user-msg`;
    msgDiv.innerText = text; chatContainer.insertBefore(msgDiv, agentStatus); chatContainer.scrollTop = chatContainer.scrollHeight;
}

// ==========================================
// 解析器：将 [偏误评分] 转化为可视化的漂亮进度条
// ==========================================
function parseMarkdownWithDashboard(text) {
    let html = text;

    // 核心：拦截 [偏误评分] 并替换为动态仪表盘
    html = html.replace(/\[偏误评分\]\s*(.*?)(\n|$)/, function(match, p1) {
        let scores = p1.split(',').map(s => s.trim());
        let barsHtml = scores.map(s => {
            let parts = s.split(':'); if (parts.length !== 2) return '';
            let name = parts[0].trim(); let score = parseInt(parts[1]);
            let color = score > 80 ? '#ef4444' : (score > 60 ? '#f59e0b' : '#3b82f6');
            return `<div class="score-row">
                        <div class="score-label">${name}</div>
                        <div class="score-bar-bg"><div class="score-bar" style="width:${score}%; background:${color};"></div></div>
                        <div class="score-num">${score}</div>
                    </div>`;
        }).join('');
        if (!barsHtml) return '';
        return `<div class="bias-dashboard">
                    <div class="dash-title">📊 交易前行为偏误雷达</div>
                    ${barsHtml}
                </div>`;
    });

    // 基础的 Markdown 替换
    html = html.replace(/^---/gm, '<hr>');
    html = html.replace(/^[\*\-] (.*?)(?=\n|$)/gm, '<li>$1</li>');
    html = html.replace(/\*\*([^\*]+)\*\*/g, '<b>$1</b>')
               .replace(/### (.*?)(?=\n|$)/g, '<h3>$1</h3>')
               .replace(/## (.*?)(?=\n|$)/g, '<h2>$1</h2>')
               .replace(/\n/g, '<br>')
               .replace(/<\/h3><br>/g, '</h3>')
               .replace(/<\/h2><br>/g, '</h2>');
    return html;
}

// ==========================================
// 交互闭环与反悔警告机制
// ==========================================
function appendFeedbackAndDecision(containerElement) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
        <div class="feedback-box">
            <span style="font-weight:600;">🤖 评价本次诊断：</span>
            <span style="color:#64748b;">是否准确命中了您的心理预期？</span>
            <div style="margin-left:auto;">
                <button class="feedback-btn" onclick="submitFeedback(this)">👍 准确</button>
                <button class="feedback-btn" onclick="submitFeedback(this)">👎 有偏差</button>
            </div>
        </div>

        <div class="decision-box">
            <div style="font-size: 13px; color: #475569; margin-bottom: 15px; font-weight:600;">👉 请根据上述风险提示，做出您的最终决定：</div>
            <button class="decision-btn safe-btn" onclick="makeDecision(this, 'safe')">我已冷静，放弃本次交易</button>
            <button class="decision-btn risk-btn" onclick="makeDecision(this, 'risk')">风险自担，执意执行交易</button>
        </div>
    `;
    containerElement.appendChild(wrap);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// 处理用户赞/踩反馈
window.submitFeedback = function(btn) {
    const box = btn.closest('.feedback-box');
    box.innerHTML = `<span style="color:#16a34a; font-weight:bold;">✅ 感谢您的反馈！您的打分将帮助模型自我迭代进化。</span>`;
    updateCurrentSession();
};

// 核心反悔阻断逻辑
window.makeDecision = function(btnElement, type) {
    const box = btnElement.closest('.decision-box');
    if (type === 'safe') {
        box.outerHTML = `<div class="msg-safe">✅ <b>系统记录：</b> 恭喜！您成功经受住了冷静期的考验，避免了一次潜在的非理性交易。操作已安全终止。</div>`;
        updateCurrentSession();
    } else {
        // 如果用户执意要买，弹出红色刺眼的最终警告！
        box.innerHTML = `
            <div class="warning-overlay">
                <p>⚠️ 系统最高级别警告</p>
                <div style="font-size:13px; color:#475569; margin-bottom:15px; line-height:1.6;">
                    雷达显示您目前处于极高的<b>【过度自信】</b>状态。您正在无视系统给出的客观风险提示。<br>
                    如果您执意按下确认键，此笔交易将被永久打上 <b style="color:#991b1b; background:#fecaca; padding:2px 4px; border-radius:4px;">负面非理性标签</b>，并封存在您的复盘库中，系统将于1个月后强制您进行复盘。
                </div>
                <button class="warning-confirm-btn" onclick="confirmRisk(this)">我清楚后果，确认买入</button>
                <button class="warning-cancel-btn" onclick="cancelRisk(this)">算了，我再想想</button>
            </div>
        `;
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
};

window.confirmRisk = function(btnElement) {
    const box = btnElement.closest('.decision-box');
    box.outerHTML = `<div class="msg-risk">🚨 <b>系统记录：</b> 操作已执行。您的【执意交易】行为已归档入个人复盘库。系统期待1个月后与您验证结果。</div>`;
    updateCurrentSession();
};

window.cancelRisk = function(btnElement) {
    const box = btnElement.closest('.decision-box');
    box.outerHTML = `<div class="msg-safe">✅ <b>系统记录：</b> 伟大的止步！您成功在最后一刻战胜了冲动，交易已安全终止。</div>`;
    updateCurrentSession();
};
