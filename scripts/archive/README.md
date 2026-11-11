# 归档：各阶段的一次性验证脚本

这些脚本是项目早期逐阶段开发时写的**自查 / 截图工具**（headless Chrome、CDP、
Playwright 风格），用于当时验证像素、间距、封面拦截这类问题。

已经全部过时，原因：

- 依赖本机的 `/usr/bin/google-chrome` 与 `shots/` 目录结构，不是 CI 能跑的东西
- 断言写死的是当时的数值（比如 66px 底栏、41 条回归项），后来设计改过
- 目标文件里有些路径已经不存在

留着只是因为 PHASE_*.md 文档里引用了它们，作为「当时怎么验证的」的记录。
**不要在新工作里使用**。

现在还有效的工具脚本在上一级 `scripts/`：

| 脚本 | 用途 |
|---|---|
| `build.mjs` | 把 src/ 内联成 dist/index.html |
| `inline-covers.mjs` | 把专辑封面转成 data URI |
| `prepare_images.py` | 图片预处理 |
| `c2-compose.py` | 封面合成 |
