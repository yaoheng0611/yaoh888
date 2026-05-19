# Render 免费部署

推荐目标地址：

- `https://yaoh888.onrender.com`
- 如果 `yaoh888` 被占用，可以用 `https://yaoh888-invest.onrender.com`

Render 免费 Web Service 可以运行本项目的 Node 后端，所以比 GitHub Pages 更适合当前版本。

## 部署步骤

1. 把项目上传到 GitHub 私有仓库或公开仓库。
2. 打开 Render Dashboard。
3. New > Blueprint。
4. 选择这个仓库，Render 会读取 `render.yaml`。
5. 创建服务时填两个 Secret 环境变量：
   - `FINNHUB_API_KEY`
   - `DEEPSEEK_API_KEY`
6. 服务名保持 `yaoh888`，如果名字可用，公网地址就是：
   - `https://yaoh888.onrender.com`

## 注意

Render 免费服务闲置一段时间会休眠，第一次打开可能要等几十秒。

当前项目使用本地 SQLite 文件。免费部署能跑起来，但免费实例文件系统不适合作为长期可靠数据库。后续如果要长期使用，建议把交易和持仓数据迁移到免费 Postgres 或 Supabase。
