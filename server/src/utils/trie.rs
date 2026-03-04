//! Trie 压缩实现
//! 
//! 用于压缩信号名列表，提取公共前缀

use std::collections::HashMap;

/// Trie 节点
#[derive(Default, Clone)]
pub struct TrieNode {
    /// 子节点映射
    pub children: HashMap<char, TrieNode>,
    /// 是否是完整信号名的结尾
    pub is_end: bool,
    /// 存储完整信号名（仅在 is_end 为 true 时有效）
    pub full_name: Option<String>,
}

impl TrieNode {
    /// 创建新的 Trie 节点
    pub fn new() -> Self {
        Self {
            children: HashMap::new(),
            is_end: false,
            full_name: None,
        }
    }

    /// 插入信号名
    pub fn insert(&mut self, name: &str) {
        let mut node = self;
        for ch in name.chars() {
            node = node.children.entry(ch).or_insert_with(TrieNode::new);
        }
        node.is_end = true;
        node.full_name = Some(name.to_string());
    }

    /// 从多个信号名构建 Trie
    pub fn from_signals(signals: &[String]) -> Self {
        let mut root = TrieNode::new();
        for signal in signals {
            root.insert(signal);
        }
        root
    }

    /// 将 Trie 序列化为压缩字符串
    /// 
    /// 格式：公共前缀1<SEP>后缀1<SEP>后缀2<GROUP_SEP>公共前缀2<SEP>后缀1...
    /// 
    /// 例如：
    /// - 输入：["tb_top.u_dut.sig1", "tb_top.u_dut.sig2", "tb_top.other.sig3"]
    /// - 输出："tb_top.u_dut.\x01sig1\x01sig2\x02tb_top.other.\x01sig3"
    pub fn serialize(&self) -> String {
        let mut result = String::new();
        let mut first_group = true;

        for (prefix, suffixes) in self.extract_common_prefixes() {
            if !first_group {
                result.push('\x02'); // 组分隔符
            }
            first_group = false;

            // 添加公共前缀
            result.push_str(&prefix);

            // 添加后缀列表
            for (i, suffix) in suffixes.iter().enumerate() {
                result.push('\x01'); // 后缀分隔符
                result.push_str(suffix);
            }
        }

        result
    }

    /// 从序列化字符串反序列化
    /// 
    /// 返回原始信号名列表
    pub fn deserialize(serialized: &str) -> Vec<String> {
        let mut signals = Vec::new();

        // 按组分隔符分割
        for group in serialized.split('\x02') {
            if group.is_empty() {
                continue;
            }

            // 找到第一个后缀分隔符
            if let Some(pos) = group.find('\x01') {
                let prefix = &group[..pos];
                let suffixes_part = &group[pos + 1..];

                // 按后缀分隔符分割
                for suffix in suffixes_part.split('\x01') {
                    if !suffix.is_empty() {
                        signals.push(format!("{}{}", prefix, suffix));
                    }
                }
            } else {
                // 没有后缀，整个就是信号名
                signals.push(group.to_string());
            }
        }

        signals
    }

    /// 提取公共前缀和后缀列表
    /// 
    /// 返回 [(公共前缀, [后缀1, 后缀2, ...]), ...]
    fn extract_common_prefixes(&self) -> Vec<(String, Vec<String>)> {
        let mut result = Vec::new();
        let mut current_prefix = String::new();
        self.extract_prefixes_recursive(&mut current_prefix, &mut result);
        result
    }

    fn extract_prefixes_recursive(
        &self,
        prefix: &mut String,
        result: &mut Vec<(String, Vec<String>)>,
    ) {
        // 收集当前节点的所有后缀
        let mut suffixes = Vec::new();
        self.collect_suffixes(prefix, &mut suffixes);

        if !suffixes.is_empty() {
            result.push((prefix.clone(), suffixes));
        }

        // 继续遍历子节点
        for (ch, child) in &self.children {
            prefix.push(*ch);
            child.extract_prefixes_recursive(prefix, result);
            prefix.pop();
        }
    }

    fn collect_suffixes(&self, prefix: &str, suffixes: &mut Vec<String>) {
        if self.is_end {
            // 计算后缀（去掉公共前缀的部分）
            if let Some(ref full_name) = self.full_name {
                if full_name.len() > prefix.len() {
                    suffixes.push(full_name[prefix.len()..].to_string());
                } else {
                    suffixes.push(String::new());
                }
            }
        }

        for (_, child) in &self.children {
            child.collect_suffixes(prefix, suffixes);
        }
    }

    /// 计算压缩率
    pub fn compression_ratio(&self, original_signals: &[String]) -> f64 {
        let original_len: usize = original_signals.iter().map(|s| s.len() + 1).sum();
        let compressed = self.serialize();
        let compressed_len = compressed.len();

        if original_len == 0 {
            return 1.0;
        }

        1.0 - (compressed_len as f64 / original_len as f64)
    }
}

/// 编码信号名列表（支持 Trie 压缩）
pub fn encode_signals_with_trie(signals: &[String]) -> String {
    if signals.len() <= 1 {
        // 单个信号，直接使用 Base64
        let joined = signals.join(",");
        format!("b64:{}", base64::encode(&joined))
    } else {
        // 多个信号，使用 Trie 压缩
        let trie = TrieNode::from_signals(signals);
        let compressed = trie.serialize();
        format!("trie:{}", base64::encode(&compressed))
    }
}

/// 解码信号名列表（支持 Trie 压缩）
pub fn decode_signals(encoded: &str) -> Result<Vec<String>, String> {
    if encoded.starts_with("b64:") {
        // Base64 解码
        let b64_part = &encoded[4..];
        let decoded = base64::decode(b64_part)
            .map_err(|e| format!("Base64 decode error: {}", e))?;
        let decoded_str = String::from_utf8(decoded)
            .map_err(|e| format!("UTF-8 decode error: {}", e))?;

        Ok(decoded_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    } else if encoded.starts_with("trie:") {
        // Trie 解压缩
        let b64_part = &encoded[5..];
        let decoded = base64::decode(b64_part)
            .map_err(|e| format!("Base64 decode error: {}", e))?;
        let compressed_str = String::from_utf8(decoded)
            .map_err(|e| format!("UTF-8 decode error: {}", e))?;

        Ok(TrieNode::deserialize(&compressed_str))
    } else {
        Err("Invalid encoding format. Expected 'b64:' or 'trie:' prefix".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trie_basic() {
        let signals = vec![
            "tb_top.u_dut.sig1".to_string(),
            "tb_top.u_dut.sig2".to_string(),
            "tb_top.other.sig3".to_string(),
        ];

        let trie = TrieNode::from_signals(&signals);
        let serialized = trie.serialize();
        let deserialized = TrieNode::deserialize(&serialized);

        assert_eq!(deserialized.len(), 3);
        assert!(deserialized.contains(&"tb_top.u_dut.sig1".to_string()));
        assert!(deserialized.contains(&"tb_top.u_dut.sig2".to_string()));
        assert!(deserialized.contains(&"tb_top.other.sig3".to_string()));
    }

    #[test]
    fn test_encode_decode() {
        let signals = vec![
            "tb_top.u_dut.sig1".to_string(),
            "tb_top.u_dut.sig2".to_string(),
        ];

        let encoded = encode_signals_with_trie(&signals);
        let decoded = decode_signals(&encoded).unwrap();

        assert_eq!(decoded.len(), 2);
        assert!(decoded.contains(&"tb_top.u_dut.sig1".to_string()));
        assert!(decoded.contains(&"tb_top.u_dut.sig2".to_string()));
    }

    #[test]
    fn test_single_signal() {
        let signals = vec!["clk".to_string()];

        let encoded = encode_signals_with_trie(&signals);
        assert!(encoded.starts_with("b64:"));

        let decoded = decode_signals(&encoded).unwrap();
        assert_eq!(decoded, vec!["clk"]);
    }
}
