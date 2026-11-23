# agent-memory 中心（hub）镜像：只带 hub/、设备端脚本（给加入码安装用）、演示数据生成器和入口脚本。
# 构建：docker build -t agent-memory .
# 网络受限时可换基础镜像和 Alpine 软件源：--build-arg NODE_IMAGE=<你的 node:20-alpine 镜像> --build-arg ALPINE_MIRROR=https://<镜像站>/alpine
ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE}

# 中心把每条记忆存成 git 仓库里的 markdown 文件，运行时要 git；
# tini 当 1 号进程：git 提交后会拉起后台 gc，退出后要有人收尸，否则容器里越攒越多僵尸进程
ARG ALPINE_MIRROR=
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s#https\?://[^/]*/alpine#${ALPINE_MIRROR%/}#" /etc/apk/repositories; fi \
 && apk add --no-cache git tini

WORKDIR /app
COPY package.json ./
COPY hub/ hub/
COPY agent/kb-agent.mjs agent/kb-agent.mjs
COPY scripts/demo-data.mjs scripts/demo-data.mjs
COPY docker/entrypoint.mjs docker/entrypoint.mjs
# 中心从自己的目录里读设备端脚本（加入码安装、设备自动升级），用符号链接避免放两份
RUN ln -s ../agent/kb-agent.mjs hub/kb-agent.mjs \
 && mkdir /data && chown node:node /data

ENV NODE_ENV=production \
    AGENT_MEMORY_CONFIG=/data/config.json
USER node
# 配置、仓库、状态、对话存档、令牌都在这个卷里
VOLUME /data
EXPOSE 8790
# 演示模式首次启动要先生成数据，给足启动宽限
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD ["node", "docker/entrypoint.mjs", "health"]
ENTRYPOINT ["/sbin/tini", "--", "node", "docker/entrypoint.mjs"]
CMD ["serve"]
