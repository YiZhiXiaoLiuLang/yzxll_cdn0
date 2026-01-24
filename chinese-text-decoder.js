/**
 * ChineseTextDecoder - 中文乱码恢复工具库
 * 支持多种编码之间的转换，特别针对中文乱码问题优化
 */

class ChineseTextDecoder {
    constructor() {
        this.lastConvertedText = '';
        this.encodings = {
            'latin1': 'Latin-1 (ISO-8859-1)',
            'gbk': 'GBK',
            'gb2312': 'GB2312',
            'big5': 'Big5',
            'utf-8': 'UTF-8',
            'cp1252': 'CP1252 (Windows-1252)',
            'shift_jis': 'Shift_JIS (日文)',
            'euc-kr': 'EUC-KR (韩文)'
        };
    }

    /**
     * 主转换函数
     * @param {string} text - 需要转换的文本
     * @param {string} sourceEncoding - 源编码
     * @param {string} targetEncoding - 目标编码
     * @returns {string} 转换后的文本
     */
    convert(text, sourceEncoding, targetEncoding) {
        if (!text || typeof text !== 'string') {
            throw new Error('请输入有效的文本');
        }

        if (!sourceEncoding || !targetEncoding) {
            throw new Error('请指定源编码和目标编码');
        }

        try {
            const convertedText = this.decodeText(text.trim(), sourceEncoding, targetEncoding);
            this.lastConvertedText = convertedText;
            return convertedText;
        } catch (error) {
            throw new Error(`转换失败：${error.message}`);
        }
    }

    /**
     * 解码文本
     * @private
     */
    decodeText(text, sourceEnc, targetEnc) {
        try {
            // 如果是相同编码，直接返回
            if (sourceEnc === targetEnc) {
                return text;
            }

            // 使用TextDecoder进行解码
            const decoder = new TextDecoder(targetEnc);
            const bytes = this.stringToBytes(text, sourceEnc);
            return decoder.decode(bytes);
        } catch (e) {
            throw new Error(`编码转换失败：${sourceEnc} → ${targetEnc}`);
        }
    }

    /**
     * 将字符串转换为字节数组
     * @private
     */
    stringToBytes(str, encoding) {
        const bytes = [];

        // 处理不同编码的转换
        if (encoding.includes('latin') || encoding.includes('iso-8859') ||
            encoding.includes('cp1252') || encoding.includes('windows-1252')) {
            // Latin-1系列编码：每个字符取低8位
            for (let i = 0; i < str.length; i++) {
                const code = str.charCodeAt(i);
                bytes.push(code & 0xFF);
            }
        } else if (encoding === 'utf-8') {
            // UTF-8编码：使用TextEncoder
            const encoder = new TextEncoder();
            return encoder.encode(str);
        } else {
            // 其他编码（GBK, GB2312, Big5等）
            // 这里使用更稳健的转换方法
            for (let i = 0; i < str.length; i++) {
                const code = str.charCodeAt(i);
                
                if (code > 0xFF) {
                    // 处理双字节字符
                    if (encoding === 'gbk' || encoding === 'gb2312' || encoding === 'big5') {
                        // 对于中文字符集，尝试正确的字节分割
                        // 高位字节
                        bytes.push((code >> 8) & 0xFF);
                        // 低位字节
                        bytes.push(code & 0xFF);
                    } else {
                        // 其他双字节编码，使用通用方法
                        bytes.push(code & 0xFF, (code >> 8) & 0xFF);
                    }
                } else {
                    // 单字节字符
                    bytes.push(code);
                }
            }
        }

        return new Uint8Array(bytes);
    }

    /**
     * 获取所有支持的编码列表
     * @returns {Object} 编码名称和描述的映射
     */
    getSupportedEncodings() {
        return { ...this.encodings };
    }

    /**
     * 添加自定义编码
     * @param {string} encoding - 编码标识
     * @param {string} description - 编码描述
     */
    addEncoding(encoding, description) {
        this.encodings[encoding] = description;
    }

    /**
     * 尝试自动检测编码并转换（实验性功能）
     * @param {string} text - 需要转换的文本
     * @param {string} targetEncoding - 目标编码（默认UTF-8）
     * @returns {Object} 包含结果和检测到的编码
     */
    autoConvert(text, targetEncoding = 'utf-8') {
        const commonEncodings = ['latin1', 'gbk', 'gb2312', 'big5', 'cp1252'];
        const results = [];

        for (const encoding of commonEncodings) {
            try {
                const result = this.convert(text, encoding, targetEncoding);
                
                // 简单的有效性检查：看结果是否包含中文字符
                const chineseCharCount = (result.match(/[\u4e00-\u9fa5]/g) || []).length;
                
                results.push({
                    encoding,
                    text: result,
                    confidence: chineseCharCount
                });
            } catch (e) {
                // 跳过转换失败的情况
            }
        }

        // 按置信度排序
        results.sort((a, b) => b.confidence - a.confidence);

        return {
            bestMatch: results[0] || null,
            allResults: results
        };
    }

    /**
     * 获取最后转换的文本
     * @returns {string} 最后转换的文本
     */
    getLastConvertedText() {
        return this.lastConvertedText;
    }

    /**
     * 复制文本到剪贴板
     * @param {string} text - 要复制的文本
     * @returns {Promise<boolean>} 是否复制成功
     */
    async copyToClipboard(text = this.lastConvertedText) {
        if (!text) {
            throw new Error('没有文本可以复制');
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            } else {
                // 降级方案
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                textArea.style.top = '-999999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
                return true;
            }
        } catch (error) {
            console.error('复制失败:', error);
            return false;
        }
    }

    /**
     * 下载转换结果为文件
     * @param {string} text - 要保存的文本
     * @param {string} sourceEncoding - 源编码（用于文件名）
     * @param {string} targetEncoding - 目标编码（用于文件名）
     * @param {string} filename - 自定义文件名
     */
    downloadAsFile(text = this.lastConvertedText, sourceEncoding = '', targetEncoding = '', filename = '') {
        if (!text) {
            throw new Error('没有文本可以保存');
        }

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        if (!filename) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            filename = `converted_text_${sourceEncoding}_to_${targetEncoding}_${timestamp}.txt`;
        }

        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// 导出库
export default ChineseTextDecoder;

// 浏览器全局使用
if (typeof window !== 'undefined') {
    window.ChineseTextDecoder = ChineseTextDecoder;
}