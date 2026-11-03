# Mercury Inception

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![author](https://img.shields.io/badge/author-Sliverkiss-8A2BE2)](https://github.com/Sliverkiss)
[![magpie](https://img.shields.io/badge/magpie-插件-00ADD8)](https://usemagpie.ai)

**Inception Mercury（Mercury 3）供应商插件** —— [magpie](https://usemagpie.ai) / OpenCode 专用。

**完全匿名，无需账号，无需密钥，安装即用。**

Mercury 3 是 Inception Labs 的扩散式大语言模型（diffusion LLM），生成以整块方式进行、速度快，特别适合**自动审批**、**意图判断**这类需要低延迟结构化判定的场景，也完全胜任日常对话与多步工具调用。

## 功能

- **零配置匿名接入** —— 插件自动完成 Vercel 安全检查点的 PoW 解题与会话令牌管理，登录只需点一下"启用"
- **推理强度可选** —— none / low / medium / high 四档思维强度，按任务精度需求调节
- **完整工具调用** —— 标准 OpenAI `tools` 桥接：截断、解析失败、模型拒答都会自动恢复重试一次
- **推理过程透传** —— `reasoning_content` 增量流式输出
- **联网搜索引用** —— 搜索来源自动注入 `annotations`
- **流式 / 非流式** —— 完整 OpenAI chat completions 兼容；空回答返回真实的 HTTP 502，绝不静默
- **Token 用量统计** —— 上游不返回 usage，网关按 ~4 字符/token 自算并随每个响应返回标准 `usage`（额度展示用途，非计费数据）

## 快速开始

```bash
magpie plugin add /path/to/inceptionlab
magpie plugin login inceptionlab    # 点一下"启用 Inception Mercury（匿名，无需密钥）"
magpie provider test inceptionlab   # ✓ chat · mercury-3
```

然后在任意 agent 里选择 `inceptionlab/mercury-3`。

## 模型

| id | 名称 | 说明 |
|---|---|---|
| `mercury-3` | Mercury 3 | 扩散模型 · 1M 上下文 · 推理强度可调 · 支持工具调用 · 免费 |

上游没有模型列表接口，目录为静态声明。

## 工作原理

```
对话请求 → 清算环（PoW 解题换 _vcrcs cookie，与 UA 绑定）
        → /api/session 匿名令牌池（30 分钟轮换）
        → POST /api/chat（SSE）
        → 还原为 OpenAI 流式帧返回给 agent
```

插件只做传输与协议桥接，不改动模型输出内容：

- **清算**（`src/clearance.mjs`）：双槽 cookie 环，补槽完全按需（无后台循环、无冷却、无退避）。被挑战先退役并换槽重放；备用槽也被挑战时强制真实求解后再重放一次；再失败就快速 503，下个请求立即重试（边缘按自己的节奏恢复，实测约 3 分钟）；cookie 45 分钟换新；探测缓存在任何挑战出现时立即作废。
- **令牌池**（`src/session-pool.mjs`）：匿名令牌轮转使用；401/403 丢弃并换新重试。
- **工具桥接**（`src/tools-*.mjs`）：函数清单渲染进提示词，`<tool_call>` 围栏解析回标准 `tool_calls`；零调用轮先分类（截断 / 解析失败 / 拒答）再限定一次恢复重试，坏轮次不会流向客户端。
- **对话过长**：上游 100 条消息上限以内的"会话累积超长"会自动换新令牌原样重放一次。

## 存储

登录状态仅为 `{type:"api", key:"anonymous", expires:0}`，写入 magpie 的 `plugin-auth.json` —— 没有任何秘密。清算 cookie 与令牌池只存在于进程内存。

## 开发

```bash
npm test    # node --test：PoW 求解向量、围栏解析、对话行为（mock 上游）
```

测试跑在 Node ≥ 22.19；生产宿主是 magpie 的 Bun 运行时（对边缘走 HTTP/2）。

## 免责声明

本项目对接一个免费公开的网页端点，仅用于个人互操作目的。与 Inception Labs 无关联。请合理使用，风险自负。

## 许可证

MIT © Sliverkiss
