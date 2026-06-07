(function() {
    // ---------- 配置 ----------
    const API_BASE = 'https://sfzapipool.yzzzzhhh.dpdns.org';
    const REQUEST_TIMEOUT = 8000;

    // 缓存查询结果 { "phone:15012345678": "陕西 西安 移动", "sfz:11010119900307663X": "北京市东城区" }
    const cache = new Map();

    // 存储被修改的文本节点及其原始内容
    const modifiedNodes = new Map();

    // UI 元素
    let toggleButton = null;
    let isActive = false;       // 当前是否处于“标注模式”
    let isProcessing = false;  // 防并发锁

    // 弹窗相关
    let modalContainer = null;

    // ---------- 正则 ----------
    const PHONE_REGEX = /\b1\d{10}\b/g;
    const SFZ_REGEX = /\b(?:\d{17}[\dXx]|\d{15})\b/g;

    // ---------- 辅助函数 ----------
    /**
     * 从文本中提取所有手机号和身份证号
     * @param {string} text 
     * @returns {Array<{value: string, type: 'phone'|'sfz', index: number}>}
     */
    function extractNumbers(text) {
        const matches = [];
        let match;
        while ((match = PHONE_REGEX.exec(text)) !== null) {
            matches.push({ value: match[0], type: 'phone', index: match.index });
        }
        while ((match = SFZ_REGEX.exec(text)) !== null) {
            if (match[0].length === 11) continue;
            matches.push({ value: match[0], type: 'sfz', index: match.index });
        }
        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    /**
     * 查询归属地（带缓存）
     */
    async function fetchLocation(type, value) {
        const cacheKey = `${type}:${value}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        let url = type === 'phone'
            ? `${API_BASE}/phone/txt?phone=${encodeURIComponent(value)}`
            : `${API_BASE}/sfz/txt?sfz=${encodeURIComponent(value)}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            const response = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'text/plain' } });
            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 404 || response.status === 400) cache.set(cacheKey, null);
                return null;
            }

            let location = await response.text();
            location = location.trim();
            if (!location || location.startsWith('Segment ') || location.startsWith('Address code ') ||
                location.startsWith('Missing ') || location.startsWith('ID number ') ||
                location.startsWith('Invalid ') || location.startsWith('Internal server error')) {
                cache.set(cacheKey, null);
                return null;
            }

            let formatted;
            if (type === 'phone') {
                formatted = location.replace(/-/g, ' ')
                                    .replace('中国移动', '移动')
                                    .replace('中国联通', '联通')
                                    .replace('中国电信', '电信');
                formatted = `[${formatted}]`;
            } else {
                formatted = `[${location}]`;
            }
            cache.set(cacheKey, formatted);
            return formatted;
        } catch (err) {
            console.warn(`查询失败 ${type}:${value}`, err);
            return null;
        }
    }

    /**
     * 对单个文本节点进行标注（可选过滤类型）
     * @param {Text} textNode 
     * @param {{ phone: boolean, sfz: boolean }} options
     * @returns {Promise<boolean>}
     */
    async function annotateTextNode(textNode, options = { phone: true, sfz: true }) {
        const originalText = textNode.nodeValue;
        if (!originalText || originalText.trim() === '') return false;

        const matches = extractNumbers(originalText);
        if (matches.length === 0) return false;

        // 根据选项决定是否查询归属地（不勾选的类型直接给 null）
        const matchInfo = matches.map(m => ({
            ...m,
            promise: ((m.type === 'phone' && !options.phone) || (m.type === 'sfz' && !options.sfz))
                ? Promise.resolve(null)
                : fetchLocation(m.type, m.value)
        }));

        const locations = await Promise.all(matchInfo.map(m => m.promise));

        // 构建新文本，仅当归属地存在时才追加
        let newText = '';
        let lastIndex = 0;
        for (let i = 0; i < matchInfo.length; i++) {
            const info = matchInfo[i];
            const locationText = locations[i];
            const start = info.index;
            const end = start + info.value.length;
            newText += originalText.slice(lastIndex, start);
            newText += info.value;
            if (locationText) newText += ` ${locationText}`;
            lastIndex = end;
        }
        newText += originalText.slice(lastIndex);

        if (newText !== originalText) {
            textNode.nodeValue = newText;
            if (!modifiedNodes.has(textNode)) modifiedNodes.set(textNode, originalText);
            return true;
        }
        return false;
    }

    /**
     * 清除所有标注，恢复原始文本
     */
    function removeAnnotations() {
        for (const [textNode, originalText] of modifiedNodes.entries()) {
            if (textNode.isConnected) textNode.nodeValue = originalText;
        }
        modifiedNodes.clear();
    }

    /**
     * 执行标注（根据选项过滤类型）
     * @param {{ phone: boolean, sfz: boolean }} options
     */
    async function applyAnnotations(options = { phone: true, sfz: true }) {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    const parent = node.parentElement;
                    if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.tagName === 'CODE'))
                        return NodeFilter.FILTER_REJECT;
                    if (node.nodeValue.trim() === '') return NodeFilter.FILTER_SKIP;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        const batchSize = 15;
        for (let i = 0; i < textNodes.length; i += batchSize) {
            const batch = textNodes.slice(i, i + batchSize);
            await Promise.all(batch.map(node => annotateTextNode(node, options)));
        }
    }

    // ---------- 弹窗逻辑 ----------
    /**
     * 预扫描页面，统计手机号和身份证号出现次数
     * @returns {{ phoneCount: number, sfzCount: number }}
     */
    function preScan() {
        let phoneCount = 0;
        let sfzCount = 0;
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    const parent = node.parentElement;
                    if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.tagName === 'CODE'))
                        return NodeFilter.FILTER_REJECT;
                    if (node.nodeValue.trim() === '') return NodeFilter.FILTER_SKIP;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        while (walker.nextNode()) {
            const text = walker.currentNode.nodeValue;
            const matches = extractNumbers(text);
            matches.forEach(m => {
                if (m.type === 'phone') phoneCount++;
                else sfzCount++;
            });
        }
        return { phoneCount, sfzCount };
    }

    /**
     * 创建并显示自定义弹窗
     * @param {number} phoneCount 
     * @param {number} sfzCount 
     * @returns {Promise<{ phone: boolean, sfz: boolean } | false>} 用户确认返回选项，取消返回false
     */
    function showAnnotationModal(phoneCount, sfzCount) {
        return new Promise((resolve) => {
            // 移除旧弹窗（如果存在）
            if (modalContainer) modalContainer.remove();

            // 创建遮罩层
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.4); z-index: 10000000; display: flex;
                align-items: center; justify-content: center; font-family: system-ui, sans-serif;
            `;

            // 弹窗主体
            const modal = document.createElement('div');
            modal.style.cssText = `
                background: white; border-radius: 16px; padding: 28px 32px; min-width: 320px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.25); color: #1a1a1a;
            `;

            // 标题
            const title = document.createElement('h3');
            title.textContent = '📋 发现以下号码';
            title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px; font-weight: 600;';

            // 统计信息
            const info = document.createElement('p');
            info.textContent = `手机号 ${phoneCount} 处 · 身份证号 ${sfzCount} 处`;
            info.style.cssText = 'margin: 0 0 20px 0; color: #555; font-size: 14px;';

            // 复选框容器
            const checkboxContainer = document.createElement('div');
            checkboxContainer.style.cssText = 'margin-bottom: 24px; display: flex; flex-direction: column; gap: 12px;';

            // 手机号复选框
            const phoneLabel = document.createElement('label');
            phoneLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 15px;';
            const phoneCheckbox = document.createElement('input');
            phoneCheckbox.type = 'checkbox';
            phoneCheckbox.checked = true;
            phoneCheckbox.style.cssText = 'width: 18px; height: 18px; accent-color: #4a6cf7;';
            phoneLabel.appendChild(phoneCheckbox);
            phoneLabel.appendChild(document.createTextNode(`标注手机号（${phoneCount} 处）`));

            // 身份证复选框
            const sfzLabel = document.createElement('label');
            sfzLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 15px;';
            const sfzCheckbox = document.createElement('input');
            sfzCheckbox.type = 'checkbox';
            sfzCheckbox.checked = true;
            sfzCheckbox.style.cssText = 'width: 18px; height: 18px; accent-color: #4a6cf7;';
            sfzLabel.appendChild(sfzCheckbox);
            sfzLabel.appendChild(document.createTextNode(`标注身份证号（${sfzCount} 处）`));

            checkboxContainer.appendChild(phoneLabel);
            checkboxContainer.appendChild(sfzLabel);

            // 按钮行
            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 12px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = `
                padding: 10px 24px; border: 1px solid #ddd; border-radius: 30px; background: white;
                cursor: pointer; font-size: 14px; transition: 0.2s; color: #333;
            `;
            cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = '#f5f5f5'; });
            cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'white'; });

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = '确认标注';
            confirmBtn.style.cssText = `
                padding: 10px 24px; border: none; border-radius: 30px; background: #4a6cf7;
                color: white; cursor: pointer; font-size: 14px; font-weight: 600; transition: 0.2s;
            `;
            confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#3b5de7'; });
            confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = '#4a6cf7'; });

            buttonRow.appendChild(cancelBtn);
            buttonRow.appendChild(confirmBtn);

            // 组装
            modal.appendChild(title);
            modal.appendChild(info);
            modal.appendChild(checkboxContainer);
            modal.appendChild(buttonRow);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            modalContainer = overlay;

            // 事件处理
            const cleanup = () => {
                overlay.remove();
                modalContainer = null;
            };

            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            });

            confirmBtn.addEventListener('click', () => {
                cleanup();
                resolve({
                    phone: phoneCheckbox.checked,
                    sfz: sfzCheckbox.checked
                });
            });

            // 点击遮罩层关闭（视为取消）
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cleanup();
                    resolve(false);
                }
            });
        });
    }

    /**
     * 切换标注状态（主入口）
     */
    async function toggleAnnotation() {
        if (isProcessing) {
            console.log('操作进行中，请稍后...');
            return;
        }

        isProcessing = true;
        toggleButton.textContent = '处理中...';
        toggleButton.disabled = true;

        try {
            if (isActive) {
                // 当前已标注 → 清除标注
                removeAnnotations();
                isActive = false;
                toggleButton.textContent = '🔍 标注归属地';
                toggleButton.style.backgroundColor = '#4a6cf7';
            } else {
                // 未标注 → 先预扫描
                const { phoneCount, sfzCount } = preScan();

                if (phoneCount === 0 && sfzCount === 0) {
                    alert('当前页面未检测到手机号或身份证号');
                    return; // 保持按钮状态不变
                }

                // 弹出选项弹窗，等待用户选择
                const options = await showAnnotationModal(phoneCount, sfzCount);
                if (!options) {
                    // 用户取消
                    return;
                }

                // 用户确认，先清理可能残留的旧标注
                removeAnnotations();
                await applyAnnotations(options);
                isActive = true;
                toggleButton.textContent = '✖️ 清除标注';
                toggleButton.style.backgroundColor = '#e53e3e';
            }
        } catch (err) {
            console.error('操作出错:', err);
            alert('归属地标注出错，请查看控制台');
        } finally {
            toggleButton.disabled = false;
            isProcessing = false;
            // 确保按钮文字与状态一致
            if (!isActive) {
                toggleButton.textContent = '🔍 标注归属地';
                toggleButton.style.backgroundColor = '#4a6cf7';
            } else {
                toggleButton.textContent = '✖️ 清除标注';
                toggleButton.style.backgroundColor = '#e53e3e';
            }
        }
    }

    /**
     * 创建右下角浮动按钮
     */
    function createFloatingButton() {
        const btn = document.createElement('button');
        btn.id = 'location-annotator-btn';
        btn.textContent = '🔍 标注归属地';
        btn.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            padding: 12px 20px; background: #4a6cf7; color: white; border: none;
            border-radius: 40px; font-size: 14px; font-weight: bold; cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: all 0.2s ease;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'translateY(0)';
            btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        });
        btn.addEventListener('click', toggleAnnotation);
        document.body.appendChild(btn);
        toggleButton = btn;
    }

    // ---------- 初始化 ----------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createFloatingButton);
    } else {
        createFloatingButton();
    }
})();