# 参与贡献

感谢参与。提交前请遵守以下边界：

- 只能使用人工构造的假账号、假 Cookie 和假令牌编写测试。
- 不要提交真实 `sessionToken`、`accessToken`、Cookie 导出、HAR、浏览器配置、邮箱或账号标识。
- 不得加入遥测、远程代码、凭据上传或扩大到非 `chatgpt.com` 域的权限。
- 新增权限或改变凭据生命周期时，必须同步更新 `README.md`、`SECURITY.md` 和安全测试。

运行完整测试：

```powershell
npm test
```

提交 Pull Request 时，请说明用户可见变化、安全影响和验证方式。安全漏洞请通过仓库的私密漏洞报告功能提交，不要公开敏感细节。
