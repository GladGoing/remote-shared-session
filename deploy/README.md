# 公网 HTTPS 部署示例

本目录只包含通用模板，不包含实际服务器的域名、连接凭据、目录、网关名称或部署记录。局域网独立部署见根目录 README，无需使用本目录。

## 私有部署配置

以下示例面向已有 Nginx 网关的 Linux Docker 环境。网关负责宿主标准 `80/443`，共享服务后端不发布宿主端口，通过网关所在的 Docker 网络提供访问。

先把 `deploy/.env.example` 复制到不受 Git 跟踪的 `.local/deploy.env`，填写自己的值。模板里的 `shared.example.com`、`existing.example.com`、网络名与 `/srv/` 路径均为示例。实际配置、证书、数据库和运维记录不应提交仓库。

```sh
mkdir -p .local
cp -n deploy/.env.example .local/deploy.env
```

配置项：

| 变量 | 用途 |
| --- | --- |
| `SHARED_PUBLIC_URL` | 用户实际访问的 HTTPS 源地址，标准 443 无需写端口 |
| `SHARED_GATEWAY_NETWORK` | 已有网关所在的 Docker 网络 |
| `SHARED_SERVICE_ROOT` | 自行选择的服务状态目录，包含 ACME、备份及发行代码 |
| `SHARED_CERTIFICATES_ROOT` | 网关可读取的宿主证书根目录 |
| `SHARED_DOMAIN` | 申请证书的域名 |
| `SHARED_GATEWAY_CONTAINER` | 现有 Nginx 网关容器名 |
| `SHARED_GATEWAY_HEALTH_DOMAIN` | 网关已有 HTTPS 健康检查的域名，需提供 `/healthz` |
| `SHARED_GATEWAY_GID` | 网关进程读取证书时使用的属组，示例为 101 |

## 后端

`compose.yaml` 使用稳定的项目名和数据卷名。`app` 为内部网络，`ingress` 使用自己配置的现有网关网络；后端别名为 `shared-session-api`。升级前备份 SQLite，在副本上验证迁移，并保持已有数据卷和项目名。

```sh
docker compose --env-file .local/deploy.env -f deploy/compose.yaml config --quiet
docker compose --env-file .local/deploy.env -f deploy/compose.yaml build shared-session
docker compose --env-file .local/deploy.env -f deploy/compose.yaml up -d --no-build --wait shared-session
```

`SHARED_PUBLIC_URL` 必须与浏览器实际访问地址一致。容器内 `/healthz` 用于后端诊断，完整入口仍需验证 HTTPS 和登录授权。

## 网关与证书

将 `nginx-session.conf.fragment` 复制到自己的私有配置目录，替换示例域名、监听端口与证书挂载路径，再整合到已有网关。模板内部使用 `8080/8443`，对应由网关对外提供的标准 `80/443`；按实际容器映射调整。

模板中 `/.well-known/acme-challenge/` 对应证书根目录下的 `shared-session-acme`，其余 HTTP 请求跳转到 HTTPS。首次申请证书时先配置 HTTP 验证路径，完成证书申请和安装后再启用 HTTPS 块。

Certbot 的持久状态放在 `$SHARED_SERVICE_ROOT/acme`，webroot 放在 `$SHARED_CERTIFICATES_ROOT/shared-session-acme`。证书申请成功后，`renew-certificate.sh` 将证书安装到 `$SHARED_CERTIFICATES_ROOT/shared-session`。该目录需要映射为模板中的 `/etc/nginx/tls/shared-session`。实际域名和路径仅存在于私有环境文件及服务器配置中。

修改已有 Nginx 配置前备份，保留原站点，执行 `nginx -t` 后平滑 reload。单文件 bind mount 应原位更新以保留 inode；校验或健康检查失败时恢复原始字节。

该服务的代理请求体上限为 `12m`，与后端 JSON 上限一致，支持 8 MiB 附件的 Base64 上传。模板关闭响应缓冲并保留 SSE 长连接；不要继承其他站点较小的上传限制。

## 证书续期

发行代码应放在自己选择的服务目录下，由 `current` 指向当前发行目录。续期脚本从环境变量读取所有部署信息，不使用仓库中固定的服务器值。

`shared-session-tls-renew.service` 从通用位置 `/etc/shared-session/deploy.env` 读取实际环境配置，使用 `SHARED_SERVICE_ROOT` 定位脚本。该私有文件应仅由管理员读取，且保持与 Compose 的配置一致。根据自己的系统安装 service/timer，配置完成后再启用 timer。

脚本运行 Certbot，证书变化时先备份，再以 `0640` 安装，校验 Nginx 后平滑 reload，并检查配置的原有站点健康状态；失败时恢复旧证书。timer 每日带随机延迟检查续期。长期运行需观察任务状态和证书有效期。

## 验证与回退

本地验证使用 `node --test`。部署验收应覆盖：证书校验、HTTP 跳转、网页登录与 CSRF、插件连接授权、收件箱、附件下载及哈希、SSE，以及原有站点的健康状态。不要只用 `/healthz` 成功代表业务验收完成。

服务器专用资料应保存在自己的私有配置、系统凭据管理器及运维记录中。回退时先停止本项目后端，再恢复需要的数据库快照和匹配的旧代码；不要让旧代码写入已升级的数据库。保留原站点、现有数据卷和证书，恢复网关配置后再次校验并 reload。
