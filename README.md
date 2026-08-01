# HomuraTokido.github.io

朱鹭户焰（Homura Tokido / Corrame）的个人主页与文章站点。

访问地址：[homura-tokido.com](https://homura-tokido.com/)

纯静态网站，直接部署于 GitHub Pages，无需构建步骤。首页位于 `index.html`，其他 HTML 文件为文章页面（共享 `css/article.css` 基础样式，页面特有样式保留在各自的 `<style>` 中），图片资源存放于 `img/`。

## 本地预览

```bash
python -m http.server 8000
```

然后访问 <http://localhost:8000>。

## 部署

推送 `main` 分支即可自动部署：

```bash
git push origin main
```

GitHub Pages 会按仓库名（`HomuraTokido.github.io`）与根目录的 `CNAME` 文件（`homura-tokido.com`）自动发布到自定义域名。
