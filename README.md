# loj-download Web + Desktop

把原始的 `loj-download` CLI 改造成了一个可长期部署的 Web 服务版本，并补上了基于 Tauri 的桌面版。

用户在浏览器或桌面窗口里输入 LibreOJ 题号或题号区间后，应用会：

1. 抓取题面、测试数据、附加文件
2. 在服务器磁盘上整理成题目包目录
3. 自动打包成 zip
4. 提供任务状态查询和浏览器下载

## 特性

- 保留原有 CLI 下载能力
- 新增 Web 页面、HTTP API 和任务队列
- 新增 Tauri 桌面版，直接在本机启动本地下载服务
- 支持单题下载，也支持区间批量下载并打成一个 zip
- 下载结果落盘，适合长期部署
- 任务元数据持久化到磁盘，服务重启后仍能看到历史结果
- 支持自动清理过期任务，避免磁盘无限增长
- 通过 `LOJ_COOKIE` 可选支持需要登录后访问的题目

## 本地运行

要求 Node 20 及以上。

### Web 模式

```bash
corepack enable
yarn install
cp .env.example .env
PORT=3000 yarn start:web
```

启动后访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

### Tauri 桌面模式

额外要求：

- Rust 工具链
- 能在当前平台执行 `cargo`

开发模式：

```bash
corepack enable
yarn install
yarn desktop:dev
```

打包当前平台安装包：

```bash
yarn desktop:build
```

如果你想在 GitHub 上直接产出 Windows 安装包，仓库里已经附带了工作流：

- `.github/workflows/build-windows-desktop.yml`

把仓库推到 GitHub 后，在 `Actions -> Build Windows Desktop` 里手动运行一次，就会在 workflow artifact 里拿到 Windows 安装包。

桌面版会：

- 在本机随机端口启动一个仅本机访问的下载服务
- 自动打开 Tauri 窗口并加载这套现有网页界面
- 把任务数据保存在系统的应用本地数据目录中

桌面版打包时会把当前构建机的 Node 可执行文件复制为 Tauri sidecar，因此 Windows、macOS、Linux 需要分别在对应平台上构建。

## 环境变量

项目根目录提供了 `.env.example`，常用变量如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口 |
| `LOJ_BASE_URL` | `https://loj.ac` | 目标 LibreOJ 站点 |
| `APP_BASE_PATH` | 空 | 可选，把应用挂到某个路径下，例如 `/loj-download` |
| `LOJ_COOKIE` | 空 | 可选，登录态 Cookie，用于抓取私有或登录后可见题目 |
| `STORAGE_DIR` | `./storage` | 任务状态、归档文件和临时工作目录 |
| `JOB_CONCURRENCY` | `2` | 同时处理多少个下载任务 |
| `DOWNLOAD_CONCURRENCY` | `5` | 单个或多个任务共享的文件下载并发数 |
| `JOB_RETENTION_HOURS` | `24` | 已完成或失败任务的保留时长 |

## API

### `POST /api/jobs`

提交一个新任务：

```json
{
  "problemInput": "1-10"
}
```

`problemInput` 支持：

- `1`
- `1-10`
- `1..10`

区间长度最多 10 题，超过会直接返回错误。

### `GET /api/jobs`

查看最近 20 个任务。

### `GET /api/jobs/:id`

查看单个任务的实时状态。

### `GET /api/jobs/:id/download`

下载已完成任务对应的 zip 包。

### `GET /api/health`

健康检查接口。

## CLI 仍然可用

```bash
node bin/loj-download.js https://loj.ac/p/1
```

## 推荐部署方式

项目里已经提供了可直接改路径后使用的部署模板：

- `deploy/systemd/loj-download-web.service`
- `deploy/nginx/loj-download-web.conf`
- `deploy/nginx/loj-download-under-path.conf`
- `deploy/deploy-via-password.sh`
- `.env.example`

下面是一套比较稳的 Linux 服务器部署流程。

### 一键密码部署

如果你已经有服务器密码，可以直接在本地运行：

```bash
bash deploy/deploy-via-password.sh
```

如果你要部署到另一台服务器，比如 `43.167.213.211`：

```bash
bash deploy/deploy-via-password.sh --host 43.167.213.211
```

如果服务器上已经有站点，想共用同一个 `80/443` 端口，把下载器挂到例如 `/loj-download/`：

```bash
bash deploy/deploy-via-password.sh --host 43.167.213.211 --base-path /loj-download --skip-nginx
```

当前脚本默认会部署到：

- 服务器：`root@198.46.253.4`
- 远端目录：`/srv/loj-download-web`
- 应用监听端口：`18730`
- 外部访问地址：`http://198.46.253.4/`

脚本会提示你输入一次 root 密码，然后自动：

- 上传当前项目代码
- 在服务器上安装 Node 20 和 nginx
- 写入 systemd 服务和 nginx 配置
- 启动服务并做健康检查

如果服务器里原本就有损坏的 nginx 全局配置，脚本会尽量自动修复；如果修不好，也会保留应用继续运行，并退回到 `http://服务器IP:18730/` 这种直连方式。
如果服务器的包管理环境比较怪，导致 NodeSource 安装脚本不兼容，脚本也会自动回退到官方 Node 20 二进制安装。

### 与已有网站共用同一个端口

如果服务器上已经跑着原有网站，不要再让脚本接管 nginx 主站配置。推荐这样做：

1. 只部署应用服务，不改 nginx：

```bash
bash deploy/deploy-via-password.sh --host 43.167.213.211 --base-path /loj-download --skip-nginx
```

2. 在原网站对应的 nginx `server {}` 里，加入 `deploy/nginx/loj-download-under-path.conf` 里的 `location` 配置。

3. 重载 nginx 后，通过：

```text
http://你的域名/loj-download/
```

或

```text
http://43.167.213.211/loj-download/
```

访问下载器。

### 1. 安装依赖

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx
corepack enable
```

### 2. 部署项目

```bash
mkdir -p /srv/loj-download-web
git clone <your-repo-url> /srv/loj-download-web
cd /srv/loj-download-web
yarn install --frozen-lockfile
mkdir -p /srv/loj-download-web/storage
```

如果你不是通过 Git 部署，也可以直接把当前整个项目目录上传到 `/srv/loj-download-web`。

### 3. 配置环境变量

```bash
cp /srv/loj-download-web/.env.example /etc/loj-download-web.env
```

编辑 `/etc/loj-download-web.env`，至少确认这几项：

- `PORT=3000`
- `STORAGE_DIR=/srv/loj-download-web/storage`
- `LOJ_BASE_URL=https://loj.ac`
- `LOJ_COOKIE=` 仅在需要抓取登录后可见题目时填写

注意：`LOJ_COOKIE` 相当于登录态凭据，不要提交到仓库，也不要暴露给前端。

### 4. 启动 systemd

```bash
cp /srv/loj-download-web/deploy/systemd/loj-download-web.service /etc/systemd/system/loj-download-web.service
systemctl daemon-reload
systemctl enable --now loj-download-web
systemctl status loj-download-web
```

如果你的 Node 不在 systemd 默认 PATH 里，比如你用的是 `nvm`，请把服务文件里的 `ExecStart` 改成 Node 的绝对路径。

### 5. 配置 nginx 反向代理

```bash
cp /srv/loj-download-web/deploy/nginx/loj-download-web.conf /etc/nginx/sites-available/loj-download-web.conf
ln -sf /etc/nginx/sites-available/loj-download-web.conf /etc/nginx/sites-enabled/loj-download-web.conf
nginx -t
systemctl reload nginx
```

把配置里的 `server_name` 改成你自己的域名。

### 6. 验证

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/config
```

再通过浏览器访问你的域名，提交一个公开题号，例如 `1`。

## Docker 部署

```bash
docker build -t loj-download-web .
docker run -d \
  --name loj-download-web \
  --restart unless-stopped \
  -p 3000:3000 \
  -e PORT=3000 \
  -e STORAGE_DIR=/data \
  -v /srv/loj-download/data:/data \
  loj-download-web
```

如果你需要抓取登录后可见题目，再额外传入：

```bash
-e LOJ_COOKIE='your_cookie_here'
```
