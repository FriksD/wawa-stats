# WAWA 小说数据记录与统计

一个用于 `https://wawawriter.com/app/submission` 投稿页的 Tampermonkey 用户脚本。

记录每日小说数据：章节数、总字数、状态、历史总收益、单日收益、昨日变化、在读人数，并提供本地统计面板与 CSV 导出。

## 功能

- 自动记录每日数据
- 适配网站“延迟一天”的数据更新机制
- 本地持久化保存，数据不上传
- 全局概览：所有书收益、在读人数、今日有收益书
- 单书详情：历史趋势折线图、明细表
- 饼图：今日收益占比、在读人数分布
- CSV 导出

## 仓库文件

| 文件 | 说明 |
|---|---|
| `wawa-stats.user.js` | Tampermonkey 用户脚本本体 |
| `greasyfork-description.md` | Greasy Fork 发布用的附加说明 |
| `README.md` | 本说明文件 |
| `LICENSE` | MIT 许可证 |

## 安装

1. 安装 Tampermonkey 扩展。
2. 打开 Greasy Fork 脚本页安装，或直接安装 `wawa-stats.user.js`。
3. 打开并登录：
   `https://wawawriter.com/app/submission`
4. 刷新页面，脚本自动采集数据。

## 使用

- 右下角 `📥`：手动采集当前数据。
- 右下角 `📊`：打开统计面板。
- 统计面板默认展示全局概览，可切换单书详情。
- 点击“导出 CSV”可备份数据。

详细说明见 `greasyfork-description.md`。

## 开发与更新

1. 修改 `wawa-stats.user.js`。
2. 每次更新记得递增 `@version`。
3. 提交并推送到 GitHub 仓库 `main` 分支：

```bash
git add .
git commit -m "feat: xxx"
git push origin main
```

4. 如果 Greasy Fork 已配置同步，推送到 GitHub 后 Greasy Fork 会自动拉取新版本；否则可以在 Greasy Fork 脚本管理页手动点击“同步”。

## 许可证

[MIT](LICENSE)
