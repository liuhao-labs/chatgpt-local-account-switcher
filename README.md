# ChatGPT 本地账号切换器

[![Tests](https://github.com/liuhao-labs/chatgpt-local-account-switcher/actions/workflows/test.yml/badge.svg)](https://github.com/liuhao-labs/chatgpt-local-account-switcher/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个本地加载的 Chromium Manifest V3 扩展，用于保存多个 ChatGPT 网页会话并一键切换。

> [!WARNING]
> 这是非 OpenAI 官方项目，仅限管理你自己拥有或明确获授权使用的账号。会话 JSON 等同于登录凭据，请勿上传到 Issue、日志或任何在线工具。

## 安装

1. 在 Edge 打开 `edge://extensions`（Chrome 使用 `chrome://extensions`）。
2. 开启“开发人员模式”。
3. 选择“加载解压缩的扩展”，选中本项目目录。
4. 点击扩展图标。私人电脑可选择“直接开始”；共享电脑可设置至少 10 个字符的访问口令。

## 导入账号

1. 正常登录一个 ChatGPT 账号。
2. 打开 `https://chatgpt.com/api/auth/session`。
3. 复制页面显示的完整 JSON。
4. 打开扩展，粘贴并点击“保存账号”。对其他账号重复上述步骤。
5. 以后在扩展里点“切换”即可。

会话 JSON 等同于登录凭据。不要发给其他人，也不要粘贴到在线工具中。扩展只提取 `sessionToken` 与账号标签信息，并明确丢弃 `accessToken`。

## 更新与导出凭证

点击账号右侧的 `...` 打开操作菜单：

- **更新凭证**：粘贴该账号最新的会话 JSON。扩展会核对账号标识，不允许用另一个账号的凭证覆盖。
- **导出凭证**：下载一个可再次导入本扩展的 JSON 文件。导出文件包含有效的 `sessionToken`，任何获得文件的人都可能直接登录该账号；它不包含 `accessToken`。
- **删除账号**：只删除本地保存的记录，不改变浏览器当前登录状态。

## 安全边界

- 保险库使用 PBKDF2-SHA256（600,000 次）派生的 AES-GCM 256 位密钥加密。
- 密码模式的保险库口令仅在弹窗开启期间驻留内存，不写入浏览器存储。
- 选择直接使用后，扩展会保存随机本机解锁密钥并自动打开账号列表；密文仍保留，但能使用或复制该浏览器配置的人也能读取保存的账号。
- 扩展没有内容脚本、遥测、远程代码或外部网络请求。
- 权限限于 `cookies`、`storage`、`tabs` 和 `https://chatgpt.com/*`。
- 切换删除已知会话 Cookie，以及 `_account`、`_puid`、`__Secure-oai-is`、`oai-client-auth-info` 这些账号相关辅助状态；保留 `cf_clearance`、`oai-did` 等设备/风控 Cookie。
- 本方案无法防御能够读取浏览器进程内存、浏览器配置或键盘输入的恶意软件。

## 限制

- 这是对 ChatGPT 未公开网页实现的本地适配，不是 OpenAI 官方支持的登录接口；网页 Cookie 结构变化后可能失效。
- 会话过期后需要重新正常登录并导入。
- 忘记保险库口令后无法恢复，只能清空保险库并重新导入。
- 导出的凭证文件不受本扩展保护，使用后应转移到可信位置或删除。
- 官方账号切换功能足够时，应优先使用官方功能。

## 本地测试

```powershell
npm test
```

测试只使用人工构造的假凭据。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。任何提交都不得包含真实 Cookie、会话 JSON、访问令牌、HAR 或个人信息。

## 许可证

[MIT License](LICENSE)。ChatGPT 和 OpenAI 是其各自权利人的商标；本项目与 OpenAI 无隶属或认可关系。
