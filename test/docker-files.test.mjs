// Docker 相关文件的静态测试，不需要 docker：文件齐全、没有真实地址和密钥、演示端口只绑本机、
// README 中英文都有 Docker 一节，以及容器入口脚本（docker/entrypoint.mjs）生成配置的行为。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub, freePort } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ENTRY = path.join(ROOT, 'docker', 'entrypoint.mjs');
const FILES = ['Dockerfile', 'docker-compose.yml', '.dockerignore', 'docker/entrypoint.mjs', 'CHANGELOG.md'];

// README 里 "## Docker…" 这一节（到下一个二级标题为止）
const dockerSection = (f) => {
  const m = /^## Docker[^\n]*\n([\s\S]*?)(?=^## )/m.exec(read(f));
  return m ? m[0] : '';
};
// compose 里某个服务的文本块（两格缩进的键开始，到下一个同级键或顶层键为止）
const service = (name) => {
  const lines = read('docker-compose.yml').split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^ {3,}/.test(lines[end]))) end++;
  return lines.slice(start + 1, end).join('\n');
};

describe('Docker 文件', () => {
  it('文件齐全', () => {
    for (const f of FILES) assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少 ${f}`);
  });

  it('Dockerfile：官方 Node 20 轻量镜像、非 root、健康检查、数据卷、只装中心要用的文件', () => {
    const d = read('Dockerfile');
    assert.match(d, /^ARG NODE_IMAGE=node:20-(alpine|slim)\s*$/m);
    assert.match(d, /^FROM \$\{NODE_IMAGE\}\s*$/m);
    assert.match(d, /^USER node\s*$/m);
    assert.match(d, /^HEALTHCHECK\b/m);
    assert.match(d, /\bhealth\b/);
    assert.match(d, /^VOLUME \/data\s*$/m);
    assert.match(d, /^EXPOSE 8790\s*$/m);
    assert.match(d, /\bgit\b/, '中心运行时要 git');
    assert.match(d, /^ARG ALPINE_MIRROR=\s*$/m, 'Alpine 软件源要可选、默认为空');
    assert.match(d, /tini/, '1 号进程要能收尸（git 后台 gc）');
    const copied = [...d.matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(copied.sort(), ['agent/kb-agent.mjs', 'docker/entrypoint.mjs', 'hub/', 'package.json', 'scripts/demo-data.mjs']);
    assert.doesNotMatch(d, /^COPY\s+(\.|worker|gateway|deploy|test|docs)\b/m);
  });

  it('.dockerignore 排除版本库、依赖、运行时数据和测试', () => {
    const lines = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const must of ['.git', '**/node_modules', 'state', 'repo', 'archive', 'tokens.json', 'config.json', 'test', 'docs', 'gateway', 'worker']) {
      assert.ok(lines.includes(must), `.dockerignore 没排除 ${must}`);
    }
  });

  it('compose：演示和正式各一个 profile，演示端口只绑 127.0.0.1', () => {
    const demo = service('demo');
    const hub = service('hub');
    assert.ok(demo && hub, '找不到 demo / hub 服务');
    assert.match(demo, /profiles:\s*\[demo\]/);
    assert.match(demo, /command:\s*\["demo"\]/);
    assert.match(hub, /profiles:\s*\[hub\]/);
    // ports: 下面的每一项（"绑定地址:宿主机端口:容器端口"）
    const block = /^ {4}ports:\n((?: {6}- .*\n?)+)/m.exec(demo);
    assert.ok(block, '演示服务没有端口映射');
    const ports = block[1].split('\n').filter(Boolean).map((l) => l.replace(/^ {6}- /, '').replace(/"/g, ''));
    for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, `演示端口必须只绑 127.0.0.1：${p}`);
    for (const s of [demo, hub]) {
      assert.doesNotMatch(s, /network_mode:\s*host|privileged:\s*true/);
      assert.match(s, /:\/data\s*$/m, '数据卷要挂到 /data');
    }
    assert.doesNotMatch(demo, /AM_BIND/, '演示端口的绑定地址不能被环境变量改掉');
  });

  it('没有真实 IP、主机名、密钥', () => {
    const texts = FILES.map((f) => [f, read(f)]).concat([['README.md Docker 一节', dockerSection('README.md')], ['README.en.md Docker 一节', dockerSection('README.en.md')]]);
    for (const [name, text] of texts) {
      for (const ip of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []) assert.ok(['127.0.0.1', '0.0.0.0'].includes(ip), `${name} 里有 IP ${ip}`);
      assert.doesNotMatch(text, /\.ts\.net\b|\.internal\b|\.lan\b/i, `${name} 里有内网主机名`);
      assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name);
      assert.doesNotMatch(text, /\b[0-9a-f]{32,}\b/i, `${name} 里有长十六进制串（疑似密钥）`);
      assert.doesNotMatch(text, /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,})/, `${name} 里有疑似密钥`);
      assert.doesNotMatch(text, /(password|passwd|secret|token)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{8,}/i, `${name} 里有疑似口令赋值`);
      for (const h of text.match(/https?:\/\/[A-Za-z0-9.-]+/g) || []) {
        const host = h.replace(/^https?:\/\//, '');
        assert.match(host, /^(127\.0\.0\.1|hub\.example|keepachangelog\.com|github\.com)$/, `${name} 里有不认识的主机 ${host}`);
      }
    }
  });

  it('README 中英文都有 Docker 一节，演示只绑本机并有风险提示，示例只用占位名', () => {
    for (const [f, risk] of [['README.md', /不要.*公网/], ['README.en.md', /not .*internet/i]]) {
      assert.match(read(f), /^## Docker/m, `${f} 没有 Docker 一节`);
      const s = dockerSection(f);
      assert.ok(s.length > 400, `${f} 的 Docker 一节太短`);
      assert.match(s, /docker compose --profile demo up/);
      assert.match(s, /docker compose --profile hub up -d/);
      assert.match(s, /127\.0\.0\.1:8790/);
      assert.match(s, risk);
      assert.match(s, /add-device my-laptop/);
      assert.match(s, /hub\.example/);
      assert.match(s, /console_viewer/);
      assert.match(s, /\/data/);
    }
  });

  it('CHANGELOG 是 Keep a Changelog 格式，最上面是 0.10.0', () => {
    const c = read('CHANGELOG.md');
    assert.match(c, /^# Changelog/);
    assert.match(c, /keepachangelog\.com/);
    const heads = [...c.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)];
    assert.ok(heads.length >= 2);
    assert.equal(heads[0][1], '0.10.0');
    assert.match(c, /^### Added$/m);
    assert.match(c, /^### Changed$/m);
    assert.match(c, /^### Performance$/m);
  });
});

describe('docker/entrypoint.mjs（不需要 docker）', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-entry-test-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const run = (data, args, env = {}) => spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, AM_DATA: data, ...env },
  });

  it('首次启动按环境变量生成配置：监听 0.0.0.0、路径都在数据目录、存档标记文件', () => {
    const data = path.join(tmp, 'a');
    const r = run(data, ['add-device', 'my-laptop'], { AM_PUBLIC_URL: 'http://hub.example:9000/', AM_GATE_SECRET: 'gate-for-test', AM_CONSOLE_VIEWER: 'my-laptop' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim().split('\n').pop(), /^[0-9a-f]{64}$/, '应打印设备令牌');
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.listen, '0.0.0.0');
    assert.equal(cfg.port, 8790);
    assert.equal(cfg.public_url, 'http://hub.example:9000');
    assert.equal(cfg.gate_secret, 'gate-for-test');
    assert.equal(cfg.console_viewer, 'my-laptop');
    for (const k of ['repo', 'state', 'tokens', 'cards_dir', 'archive_dir', 'dist_dir']) assert.ok(cfg[k].startsWith(`${data}${path.sep}`), `${k} 不在数据目录里：${cfg[k]}`);
    assert.ok(fs.existsSync(path.join(data, 'archive', '.am-archive')));
    assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'tokens.json'), 'utf8')).devices['my-laptop']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(data, 'config.json')).mode & 0o077, 0, '配置里可能有 gate_secret，不该别人可读');
  });

  it('不设环境变量时的默认值；配置已存在就一个字不改', () => {
    const data = path.join(tmp, 'b');
    assert.equal(run(data, ['add-device', 'build-server']).status, 0);
    const first = fs.readFileSync(path.join(data, 'config.json'), 'utf8');
    const cfg = JSON.parse(first);
    assert.equal(cfg.public_url, 'http://127.0.0.1:8790');
    assert.equal(cfg.gate_secret, '');
    assert.ok(!('console_viewer' in cfg));
    assert.equal(run(data, ['add-device', 'my-desktop'], { AM_PUBLIC_URL: 'http://hub.example:1', AM_CONSOLE_VIEWER: 'x-y' }).status, 0);
    assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), first);
  });

  it('演示模式：数据目录不是空的、也不是演示数据时拒绝生成，里面的东西原样保留', () => {
    const data = path.join(tmp, 'c');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'tokens.json'), '{"devices":{}}');
    const r = run(data, ['demo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /拒绝/);
    assert.deepEqual(fs.readdirSync(data), ['tokens.json']);
  });

  it('health：能连上返回 0，连不上返回非 0', async () => {
    const hub = await startHub({ tokens: {} });
    try {
      const up = path.join(tmp, 'up');
      fs.mkdirSync(up);
      fs.writeFileSync(path.join(up, 'config.json'), JSON.stringify({ listen: '127.0.0.1', port: hub.port }));
      assert.equal(run(up, ['health']).status, 0);
      const down = path.join(tmp, 'down');
      fs.mkdirSync(down);
      fs.writeFileSync(path.join(down, 'config.json'), JSON.stringify({ listen: '127.0.0.1', port: await freePort() }));
      assert.notEqual(run(down, ['health']).status, 0);
    } finally {
      await hub.stop();
    }
  });
});
