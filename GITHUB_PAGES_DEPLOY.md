# GitHub Pages 免费域名发布

目标免费地址取决于你的 GitHub 用户名：

- 如果 GitHub 用户名是 `yaoh888`，创建仓库 `yaoh888.github.io` 后，网址就是 `https://yaoh888.github.io/`
- 如果 GitHub 用户名不是 `yaoh888`，但仓库名叫 `yaoh888`，网址通常是 `https://你的用户名.github.io/yaoh888/`

## 重要限制

GitHub Pages 只能托管静态页面，不能运行本项目的 `server.js`、SQLite 数据库、Finnhub API 代理、DeepSeek API 代理。

因此：

- 可以免费展示网页视觉界面
- 可以使用浏览器本地存储保存演示数据
- 不能在 GitHub Pages 里安全保存 DeepSeek/Finnhub key
- 真实行情、新闻聚合、DeepSeek 投资顾问需要部署到单独后端

## 发布步骤

1. 在 GitHub 创建仓库：
   - 推荐：`yaoh888.github.io`
   - 或者：`yaoh888`

2. 上传这些静态文件：
   - `index.html`
   - `styles.css`
   - `app.js`
   - `.nojekyll`

3. 不要上传这些文件：
   - `.env`
   - `portfolio.db`
   - `server.js`
   - `server.out.log`
   - `server.err.log`

4. 在 GitHub 仓库设置里打开 Pages：
   - Settings
   - Pages
   - Source: Deploy from a branch
   - Branch: `main`
   - Folder: `/root`

## 后端建议

要保留真实行情、新闻、DeepSeek 投资顾问，需要把后端部署到 Render、Railway、Fly.io 或类似服务，然后让 GitHub Pages 前端调用后端地址。
